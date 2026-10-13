/**
 * The vault's index comes from the delivered, still-encrypted o-charts sets
 * (127-C-d decision 6). It is what the Pi writes to disk about the charts
 * after Pi update 3, and all of it: a catalogue, as OpenCPN's chart database
 * keeps one. No feature, depth, position inside a cell, name or picture.
 *
 *   enc-charts/vault/vault-index.json (0600)  one entry per delivered file,
 *                                             exactly VAULT_INDEX_ENTRY_KEYS
 *   enc-charts/vault/removed.json (0600)      cell ids the skipper removed
 *
 * Sets are found under each root (~/Charts and enc-charts/sources/*) by the
 * same shape rules as oChartsInstaller.inspectOChartsSets: a directory holding
 * .oesu files must hold exactly one key XML, and every .oesu must be keyed;
 * a set that breaks a rule is skipped with its reason, never half-indexed.
 *
 * A restart reuses the index and re-opens only files whose encrypted hash
 * changed. A new parser schema re-opens everything once. When one cell is in
 * two sets, the newest (edition, update, issued) wins, as compareChartRevision.
 * A removal holds until a NEW delivery (a file whose encrypted hash the index
 * has never seen) contains the cell; a restart never brings it back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseKeyFile, type ChartKeyEntries } from '../sencEngine/keyFile.js';
import { loadChartSourceMetadata, resolveChartProducer } from '../sencEngine/chartProvenance.js';
import type { DecodedCatalogue } from './decoder.js';
import type { VaultCellMeta } from './protocol.js';

export const VAULT_INDEX_FILE = 'vault-index.json';
export const REMOVED_FILE = 'removed.json';

/** Every key an index entry may carry (decision 6), and no other. */
export const VAULT_INDEX_ENTRY_KEYS = [
    'cellId',
    'sourceCellId',
    'sourceHO',
    'edition',
    'updateNumber',
    'issued',
    'bbox',
    'featureCount',
    'sizeBytes',
    'contentSha256',
    'extractorSchema',
    'setDir',
    'fileName',
    'encSha256',
    'licence',
] as const;

export interface VaultFileEntry {
    cellId: string;
    /** The native ENC id from the licensed key XML, '' when the XML names none. */
    sourceCellId: string;
    sourceHO: string;
    edition: number;
    /** 0 when the SENC carries none. */
    updateNumber: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    /** The served size in bytes. */
    sizeBytes: number;
    contentSha256: string;
    extractorSchema: number;
    setDir: string;
    fileName: string;
    encSha256: string;
    licence: 'protected';
}

/** A delivered file to open, with what opening it needs. The install key lives in memory only. */
export interface PendingFile {
    cellId: string;
    setDir: string;
    fileName: string;
    filePath: string;
    installKey: string;
    sourceHO: string;
    sourceCellId?: string;
    encSha256: string;
    /** Its encrypted hash is not in the index: a new delivery (it can bring a removed cell back). */
    newDelivery: boolean;
}

export interface SkippedSet {
    set: string;
    reason: 'key-file-count' | 'key-file-invalid' | 'unkeyed-cell' | 'unreadable' | 'path-too-long';
}

/** oexserverd's command carries the chart path in a 256-byte, null-terminated field. */
export const MAX_OEX_PATH_BYTES = 255;

export interface ScanResult {
    reused: VaultFileEntry[];
    toOpen: PendingFile[];
    skippedSets: SkippedSet[];
    /** Cells whose producer could not be resolved, by id only. */
    skippedCells: string[];
    /**
     * What the walk found, as paths, sizes and modification times (no bytes
     * read): equal for two scans when no delivered file was added, removed or
     * replaced between them.
     */
    fingerprint: string;
}

const KEY_XML = /^oeuSENC-.*-sgl[0-9a-f]+\.xml$/i;
const CELL_ID = /^[A-Z0-9][A-Z0-9_-]{1,127}$/;
const MAX_DEPTH = 4;

async function fileSha256(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** Write a small state file atomically, 0600: temp beside it, then rename. */
async function writeStateFile(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}

function compareRevision(a: VaultFileEntry, b: VaultFileEntry): number {
    const date = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');
    return (
        a.edition - b.edition ||
        a.updateNumber - b.updateNumber ||
        date(a.issued).localeCompare(date(b.issued)) ||
        // The same revision in two sets: any fixed choice will do.
        a.encSha256.localeCompare(b.encSha256)
    );
}

function validEntry(raw: unknown): raw is VaultFileEntry {
    const e = raw as Record<string, unknown> | null;
    return (
        !!e &&
        typeof e === 'object' &&
        Object.keys(e).every((k) => (VAULT_INDEX_ENTRY_KEYS as readonly string[]).includes(k)) &&
        typeof e.cellId === 'string' &&
        CELL_ID.test(e.cellId) &&
        typeof e.sourceHO === 'string' &&
        Number.isInteger(e.edition) &&
        Number.isInteger(e.updateNumber) &&
        typeof e.issued === 'string' &&
        Array.isArray(e.bbox) &&
        e.bbox.length === 4 &&
        e.bbox.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        Number.isInteger(e.featureCount) &&
        Number.isInteger(e.sizeBytes) &&
        typeof e.contentSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(e.contentSha256) &&
        Number.isInteger(e.extractorSchema) &&
        typeof e.setDir === 'string' &&
        typeof e.fileName === 'string' &&
        typeof e.encSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(e.encSha256) &&
        e.licence === 'protected'
    );
}

export function entryFromDecoded(
    pending: PendingFile,
    catalogue: DecodedCatalogue,
    sha256: string,
    schema: number,
): VaultFileEntry {
    return {
        cellId: pending.cellId,
        sourceCellId: pending.sourceCellId ?? '',
        sourceHO: catalogue.sourceHO,
        edition: catalogue.edition,
        updateNumber: catalogue.updateNumber ?? 0,
        issued: catalogue.issued,
        bbox: catalogue.bbox,
        featureCount: catalogue.featureCount,
        sizeBytes: catalogue.sizeBytes,
        contentSha256: sha256,
        extractorSchema: schema,
        setDir: pending.setDir,
        fileName: pending.fileName,
        encSha256: pending.encSha256,
        licence: 'protected',
    };
}

export class VaultIndex {
    private files: VaultFileEntry[] = [];
    private removed = new Set<string>();
    /** Install keys by file path, from the key XMLs at the last scan. Memory only. */
    private keys = new Map<string, string>();
    /** setDir/fileName → modification time, for installedAt. Memory only. */
    private mtimes = new Map<string, number>();
    private servedByCell = new Map<string, VaultFileEntry>();
    /** An index has been loaded from disk or committed by a pass. */
    complete = false;
    skippedSets: SkippedSet[] = [];

    constructor(
        private readonly opts: {
            stateDir: string;
            roots: string[];
            schema: number;
            log?: Pick<Console, 'log' | 'warn'>;
            /** A test seam; production: fileSha256. */
            hashFile?: (file: string) => Promise<string>;
        },
    ) {}

    private get indexPath(): string {
        return path.join(this.opts.stateDir, VAULT_INDEX_FILE);
    }

    private get removedPath(): string {
        return path.join(this.opts.stateDir, REMOVED_FILE);
    }

    async load(): Promise<void> {
        const log = this.opts.log ?? console;
        try {
            const saved = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) as {
                version?: unknown;
                files?: unknown;
            };
            if (saved.version === 1 && Array.isArray(saved.files)) {
                this.files = saved.files.filter(validEntry);
                this.complete = true;
                if (this.files.length !== saved.files.length)
                    log.warn(`[vault] index: ${saved.files.length - this.files.length} unreadable entries dropped`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('[vault] index unreadable: re-indexing');
        }
        try {
            const saved = JSON.parse(await fs.readFile(this.removedPath, 'utf8')) as { cellIds?: unknown };
            if (Array.isArray(saved.cellIds))
                this.removed = new Set(saved.cellIds.filter((id): id is string => typeof id === 'string'));
        } catch {
            this.removed = new Set();
        }
        this.recompute();
    }

    /**
     * Walk the roots for delivered sets. With `plan`, hash every file and plan
     * the pass (reuse what is current, open the rest); without, read the key
     * XMLs and arrival times only, so indexed cells can be served at once.
     */
    async scan({ plan }: { plan: boolean }): Promise<ScanResult> {
        const result: ScanResult = { reused: [], toOpen: [], skippedSets: [], skippedCells: [], fingerprint: '' };
        const seen = createHash('sha256');
        const hashFile = this.opts.hashFile ?? fileSha256;
        const known = new Map(this.files.map((f) => [`${f.setDir}/${f.fileName}`, f]));
        const everSeen = new Set(this.files.map((f) => f.encSha256));
        const keys = new Map<string, string>();
        const mtimes = new Map<string, number>();
        const sets: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            if (entries.some((e) => e.isFile() && /\.oesu$/i.test(e.name))) sets.push(dir);
            if (depth >= MAX_DEPTH) return;
            for (const e of entries) if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
        };
        for (const root of this.opts.roots) await walk(path.resolve(root), 0);

        for (const setDir of sets.sort()) {
            const names = (await fs.readdir(setDir, { withFileTypes: true }))
                .filter((e) => e.isFile())
                .map((e) => e.name);
            const keyFiles = names.filter((n) => KEY_XML.test(n));
            for (const name of keyFiles) {
                const st = await fs.stat(path.join(setDir, name)).catch(() => null);
                seen.update(`${setDir}/${name}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}\n`);
            }
            if (keyFiles.length !== 1) {
                result.skippedSets.push({ set: setDir, reason: 'key-file-count' });
                continue;
            }
            let entries: ChartKeyEntries;
            try {
                entries = parseKeyFile(await fs.readFile(path.join(setDir, keyFiles[0]), 'utf8'));
            } catch {
                result.skippedSets.push({ set: setDir, reason: 'key-file-invalid' });
                continue;
            }
            const oesu = names.filter((n) => /\.oesu$/i.test(n)).sort();
            if (oesu.some((n) => Buffer.byteLength(path.join(setDir, n)) > MAX_OEX_PATH_BYTES)) {
                result.skippedSets.push({ set: setDir, reason: 'path-too-long' });
                continue;
            }
            const keyed = (name: string) => {
                const base = name.slice(0, -'.oesu'.length);
                return entries.get(base) ?? entries.get(base.toUpperCase());
            };
            if (oesu.some((n) => !keyed(n))) {
                result.skippedSets.push({ set: setDir, reason: 'unkeyed-cell' });
                continue;
            }
            let provenance;
            try {
                provenance = await loadChartSourceMetadata(setDir);
            } catch {
                result.skippedSets.push({ set: setDir, reason: 'unreadable' });
                continue;
            }
            for (const fileName of oesu) {
                const cellId = fileName.slice(0, -'.oesu'.length).toUpperCase();
                const key = keyed(fileName)!;
                if (!CELL_ID.test(cellId)) {
                    result.skippedCells.push(cellId.slice(0, 40));
                    continue;
                }
                let sourceHO: string;
                try {
                    sourceHO = resolveChartProducer(cellId, '', provenance, key.sourceCellId);
                } catch {
                    result.skippedCells.push(cellId);
                    continue;
                }
                const filePath = path.join(setDir, fileName);
                let encSha256: string;
                try {
                    const st = await fs.stat(filePath);
                    seen.update(`${filePath}\0${st.size}\0${st.mtimeMs}\n`);
                    mtimes.set(`${setDir}/${fileName}`, st.mtimeMs);
                    keys.set(filePath, key.installKey);
                    if (!plan) continue;
                    encSha256 = await hashFile(filePath);
                } catch {
                    result.skippedCells.push(cellId);
                    continue;
                }
                const prior = known.get(`${setDir}/${fileName}`);
                if (
                    prior &&
                    prior.encSha256 === encSha256 &&
                    prior.extractorSchema === this.opts.schema &&
                    prior.cellId === cellId &&
                    prior.sourceHO === sourceHO &&
                    prior.sourceCellId === (key.sourceCellId ?? '')
                ) {
                    result.reused.push(prior);
                } else {
                    result.toOpen.push({
                        cellId,
                        setDir,
                        fileName,
                        filePath,
                        installKey: key.installKey,
                        sourceHO,
                        ...(key.sourceCellId ? { sourceCellId: key.sourceCellId } : {}),
                        encSha256,
                        newDelivery: !everSeen.has(encSha256),
                    });
                }
            }
        }
        this.keys = keys;
        this.mtimes = mtimes;
        this.skippedSets = result.skippedSets;
        result.fingerprint = seen.update(JSON.stringify([result.skippedSets, result.skippedCells, sets])).digest('hex');
        return result;
    }

    /**
     * Make `entries` the index (the reused ones plus every file the pass
     * opened), bring back removed cells a new delivery contains, and persist.
     */
    async commit(entries: VaultFileEntry[], scan: ScanResult): Promise<void> {
        const returning = new Set(scan.toOpen.filter((p) => p.newDelivery).map((p) => p.cellId));
        let removalsChanged = false;
        for (const id of returning) if (this.removed.delete(id)) removalsChanged = true;
        this.files = entries;
        this.complete = true;
        this.recompute();
        await this.persist();
        if (removalsChanged) await this.persistRemoved();
    }

    /** Persist an interim index during a long pass (a crash restart then resumes in seconds). */
    async checkpoint(entries: VaultFileEntry[]): Promise<void> {
        const byPath = new Map(this.files.map((f) => [`${f.setDir}/${f.fileName}`, f]));
        for (const e of entries) byPath.set(`${e.setDir}/${e.fileName}`, e);
        await writeStateFile(this.indexPath, { version: 1, schema: this.opts.schema, files: [...byPath.values()] });
    }

    /** The served revision of a cell changed under the index (decision 7's hash check). */
    async replace(entry: VaultFileEntry): Promise<void> {
        this.files = this.files.map((f) => (f.setDir === entry.setDir && f.fileName === entry.fileName ? entry : f));
        this.recompute();
        await this.persist();
    }

    async remove(cellId: string): Promise<boolean> {
        if (!this.servedByCell.has(cellId)) return false;
        this.removed.add(cellId);
        this.recompute();
        await this.persistRemoved();
        return true;
    }

    /** The served entry for a cell: the newest revision, unless removed. */
    winner(cellId: string): VaultFileEntry | undefined {
        return this.servedByCell.get(cellId);
    }

    installKey(entry: VaultFileEntry): string | undefined {
        return this.keys.get(path.join(entry.setDir, entry.fileName));
    }

    servedEntries(): VaultFileEntry[] {
        return [...this.servedByCell.values()];
    }

    /** What GET /api/enc/installed lists for the vault's cells. */
    served(): VaultCellMeta[] {
        return this.servedEntries().map((e) => ({
            cellId: e.cellId,
            ...(e.sourceCellId ? { sourceCellId: e.sourceCellId } : {}),
            sourceHO: e.sourceHO,
            edition: e.edition,
            updateNumber: e.updateNumber,
            issued: e.issued,
            bbox: e.bbox,
            featureCount: e.featureCount,
            sizeBytes: e.sizeBytes,
            contentSha256: e.contentSha256,
            installedAt: new Date(this.mtimes.get(`${e.setDir}/${e.fileName}`) ?? 0).toISOString(),
            source: 'pi-decrypt',
            licence: 'protected',
        }));
    }

    private recompute(): void {
        const best = new Map<string, VaultFileEntry>();
        for (const f of this.files) {
            const prior = best.get(f.cellId);
            if (!prior || compareRevision(f, prior) > 0) best.set(f.cellId, f);
        }
        for (const id of this.removed) best.delete(id);
        this.servedByCell = new Map([...best.entries()].sort(([a], [b]) => a.localeCompare(b)));
    }

    private async persist(): Promise<void> {
        await writeStateFile(this.indexPath, { version: 1, schema: this.opts.schema, files: this.files });
    }

    private async persistRemoved(): Promise<void> {
        await writeStateFile(this.removedPath, { version: 1, cellIds: [...this.removed].sort() });
    }
}
