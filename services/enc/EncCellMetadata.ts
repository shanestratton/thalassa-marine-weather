/**
 * ENC Cell Metadata — persistence for the small "I have this cell"
 * records.
 *
 * One record per imported cell. Records are tiny (~500 bytes each)
 * and rarely change after import, so localStorage is appropriate;
 * we'll migrate to IndexedDB only if a fleet user ever has 5k+
 * cells.
 *
 * Cell metadata = the index *of* cells. The actual hazard polygons
 * live in Capacitor Filesystem as GeoJSON blobs, accessed by
 * `geojsonPath` in the metadata record.
 *
 * Public API:
 *  - listCells() → all imported cells
 *  - getCell(id) → one record
 *  - putCell(cell) → upsert (used by import flow)
 *  - removeCell(id) → forget a cell (used by user "delete chart")
 *  - cellsForBBox(bbox) → cells whose bbox intersects the query bbox
 */

import { createLogger } from '../../utils/createLogger';
import type { EncCell } from './types';
import { ENC_METADATA_PREFIX } from './types';

const log = createLogger('EncCellMetadata');

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Index key — a single record listing every cell ID we know about.
 * Keeps `listCells()` O(n) over the index size rather than scanning
 * the entire localStorage namespace each call.
 */
const INDEX_KEY = `${ENC_METADATA_PREFIX}.index`;

function recordKey(cellId: string): string {
    return `${ENC_METADATA_PREFIX}:${cellId}`;
}

function readIndex(): string[] {
    try {
        const raw = localStorage.getItem(INDEX_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch (err) {
        log.warn('readIndex failed, treating as empty', err);
        return [];
    }
}

function writeIndex(ids: string[]): void {
    localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
}

function readCell(id: string): EncCell | null {
    try {
        const raw = localStorage.getItem(recordKey(id));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        // Loose validation — refuse obviously malformed records.
        const cell = parsed as Partial<EncCell>;
        if (!cell.id || !cell.bbox || !cell.geojsonPath) {
            log.warn(`readCell ${id}: malformed record, ignoring`);
            return null;
        }
        return cell as EncCell;
    } catch (err) {
        log.warn(`readCell ${id} failed`, err);
        return null;
    }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Cells no consumer may ever see, even if a device still holds them.
 *
 * 'au-brisbane-test': a leftover GEBCO-contour TEST pack (1,512 crude
 * DEPARE bands over Moreton/Deception Bay). Its 0-0.5 m bands painted
 * "0.0 m charted — needs +2.9 m tide" over water the real AHO coastal
 * cell charts at 2-5 m, and — because its bbox is SMALLER than the
 * coastal cell's — the scale-shadow heuristic treated the junk as the
 * finer chart and dropped the real data beneath it (Shane 2026-07-10,
 * legs 9→12 off Deception Bay; likely also the engine's phantom
 * "coverage gap ~1 NM"). Every consumer (render merge, tracer grid,
 * router cell selection) lists cells through here, so the quarantine
 * heals already-synced devices without a delete-sync protocol.
 */
const QUARANTINED_CELLS = new Set(['au-brisbane-test']);

/** listCells memo — keyed to the version counter. With 172 cloud
 *  cells, every un-memoized call re-parsed ~86 KB of localStorage
 *  JSON, and hot paths (routing hazard batches, registration storms)
 *  issued it thousands of times (2026-07-12 audit). Callers must
 *  treat the returned array as READ-ONLY (copy before sorting). */
let listCache: { version: number; cells: EncCell[] } | null = null;

/**
 * List every imported cell. Memoized per registry version — cheap to
 * call anywhere, including per-frame UI reads and routing loops.
 */
export function listCells(): EncCell[] {
    if (listCache && listCache.version === version) return listCache.cells;
    const ids = readIndex();
    const out: EncCell[] = [];
    for (const id of ids) {
        if (QUARANTINED_CELLS.has(id)) continue;
        const cell = readCell(id);
        if (cell) out.push(cell);
    }
    listCache = { version, cells: out };
    return out;
}

/**
 * Get one cell by ID. Null if not imported.
 */
export function getCell(id: string): EncCell | null {
    return readCell(id);
}

/**
 * Insert or update a cell record. Used by the import pipeline
 * after a successful S-57 → GeoJSON conversion. Notifies listeners
 * so the map ENC coverage overlay refreshes immediately.
 */
export function putCell(cell: EncCell): void {
    localStorage.setItem(recordKey(cell.id), JSON.stringify(cell));
    const ids = readIndex();
    if (!ids.includes(cell.id)) {
        ids.push(cell.id);
        writeIndex(ids);
    }
    notify();
}

/**
 * Remove a cell from the metadata index. Caller is responsible for
 * deleting the GeoJSON blob from the filesystem (EncCellStore).
 * Notifies listeners.
 */
export function removeCell(id: string): void {
    localStorage.removeItem(recordKey(id));
    const ids = readIndex().filter((x) => x !== id);
    writeIndex(ids);
    notify();
}

/**
 * Find every imported cell whose bbox intersects the given bbox.
 * Used to lazy-load only the cells relevant to the current route
 * being computed.
 *
 * `bbox` is `[minLon, minLat, maxLon, maxLat]`.
 */
export function cellsForBBox(bbox: [number, number, number, number]): EncCell[] {
    const [qMinLon, qMinLat, qMaxLon, qMaxLat] = bbox;
    return listCells().filter((cell) => {
        const [cMinLon, cMinLat, cMaxLon, cMaxLat] = cell.bbox;
        // Standard bbox intersection test.
        return !(cMaxLon < qMinLon || cMinLon > qMaxLon || cMaxLat < qMinLat || cMinLat > qMaxLat);
    });
}

/**
 * Wipe all ENC metadata (does NOT delete GeoJSON blobs — that's
 * EncCellStore's job). Used by the "reset all charts" admin action.
 */
export function clearAllCellMetadata(): void {
    const ids = readIndex();
    for (const id of ids) localStorage.removeItem(recordKey(id));
    localStorage.removeItem(INDEX_KEY);
    notify();
    log.info('cleared all ENC cell metadata');
}

// ── Reactivity ────────────────────────────────────────────────────

/**
 * Lightweight subscription so UI components (and the map ENC
 * coverage overlay) can react when cells are imported / removed
 * without polling.
 *
 * We don't bother with full pub-sub semantics — there's at most a
 * handful of listeners (chart locker, map overlay). A bumped
 * version number is plenty.
 */
let version = 0;
type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
    version++;
    for (const l of listeners) {
        try {
            l();
        } catch (err) {
            log.warn('listener threw', err);
        }
    }
}

/**
 * Get the current version counter. Increments on every
 * putCell / removeCell / clearAllCellMetadata.
 */
export function getVersion(): number {
    return version;
}

/**
 * Subscribe to cell-list changes. Returns an unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
