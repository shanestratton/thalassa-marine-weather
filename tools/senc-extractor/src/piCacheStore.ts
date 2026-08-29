import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CellOutput } from './geojsonEmitter.js';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * Writers for pi-cache's chart store:
 *   <store>/cells/<cellId>.json   one cell, wrapped as `{cells: [cell]}`
 *   <store>/index.json            InstalledIndex consumed by /api/enc/installed
 *
 * Mirrors what pi-cache/src/routes/enc.ts (`saveInstalledCell`) writes, so
 * cells dropped here are immediately visible to the iOS app's `syncEncFromPi`
 * flow. `decryptBatch.ts` predates this module and carries its own inline
 * copy of the same shapes — if the store format changes, both need the change
 * (and pi-cache too, which is the canonical definition).
 */

export interface InstalledCellMeta {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    source: 'phone-upload' | 'url' | 'pi-decrypt';
    sourceUrl?: string;
}

export interface InstalledIndex {
    version: 1;
    cells: InstalledCellMeta[];
}

export async function loadPiCacheIndex(storeDir: string): Promise<InstalledIndex> {
    const path = join(storeDir, 'index.json');
    try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as InstalledIndex;
        if (parsed.version === 1 && Array.isArray(parsed.cells)) return parsed;
    } catch {
        /* fresh install or corrupt — fall through */
    }
    return { version: 1, cells: [] };
}

export async function savePiCacheIndex(storeDir: string, index: InstalledIndex): Promise<void> {
    await writeFileAtomic(join(storeDir, 'index.json'), JSON.stringify(index, null, 2));
}

export function upsertIndexEntry(index: InstalledIndex, entry: InstalledCellMeta): void {
    const existing = index.cells.findIndex((c) => c.cellId === entry.cellId);
    if (existing >= 0) index.cells[existing] = entry;
    else index.cells.push(entry);
}

/** Serialize one cell in the store's wire shape and build its index entry. */
export function cellStoreRecord(cell: CellOutput): { json: string; meta: InstalledCellMeta } {
    const json = JSON.stringify({ cells: [cell] });
    return {
        json,
        meta: {
            cellId: cell.cellId,
            sourceHO: cell.sourceHO,
            edition: cell.edition,
            issued: cell.issued,
            bbox: cell.bbox,
            featureCount: cell.stats?.emittedFeatures ?? 0,
            sizeBytes: json.length,
            installedAt: new Date().toISOString(),
            source: 'pi-decrypt',
        },
    };
}
