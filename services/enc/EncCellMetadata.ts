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
import { canonicalEncCellId, ENC_CELL_ID_PATTERN, ENC_METADATA_PREFIX, encCellStorageIdentity } from './types';

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
        const canonicalId = typeof cell.id === 'string' ? canonicalEncCellId(cell.id) : '';
        const bbox = cell.bbox;
        const usage = cell.usage;
        if (
            typeof cell.id !== 'string' ||
            !ENC_CELL_ID_PATTERN.test(canonicalId) ||
            !Array.isArray(bbox) ||
            bbox.length !== 4 ||
            !bbox.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) ||
            bbox[0] < -180 ||
            bbox[2] > 180 ||
            bbox[1] < -90 ||
            bbox[3] > 90 ||
            bbox[0] >= bbox[2] ||
            bbox[1] >= bbox[3] ||
            typeof cell.geojsonPath !== 'string' ||
            !Number.isInteger(cell.edition) ||
            (cell.edition ?? -1) < 0 ||
            !Number.isInteger(cell.hazardCount) ||
            (cell.hazardCount ?? -1) < 0 ||
            (usage !== undefined &&
                usage !== 'navigation' &&
                usage !== 'reference' &&
                usage !== 'pending' &&
                usage !== 'demo') ||
            (cell.cloudManifestVersion !== undefined &&
                (!Number.isInteger(cell.cloudManifestVersion) || cell.cloudManifestVersion < 0))
        ) {
            log.warn(`readCell ${id}: malformed record, ignoring`);
            return null;
        }
        if (encCellStorageIdentity(cell.id) !== encCellStorageIdentity(id)) {
            log.warn(`readCell ${id}: record identity mismatch, ignoring`);
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
const QUARANTINED_CELLS = new Set(['AU-BRISBANE-TEST']);

/** NOAA cell that older Thalassa builds silently bundled as a Savannah demo. */
export const LEGACY_BUNDLED_DEMO_CELL_IDS = new Set(['US5GA22M']);
const LEGACY_BUNDLED_DEMO_FLAGS = Array.from({ length: 7 }, (_, index) => `thalassa.enc.samplesImported.v${index + 1}`);

function isLiveNavigationCell(cell: EncCell): boolean {
    if (cell.usage === 'demo') return false;
    if (cell.usage === 'reference') return false;
    if (cell.usage === 'pending') return false;
    // Upgrade boundary for cloud placeholders written by older builds. A
    // verified imported cloud cell always has at least one DEPARE/DRGARE
    // feature, while the manifest-only record was stamped with zero.
    if (cell.cloudManifestVersion !== undefined && cell.hazardCount === 0) return false;
    // Upgrade boundary for devices that received the old untagged auto-seed.
    // A later user/cloud import is written with usage='navigation' by putCell,
    // so a legitimately acquired current US5GA22M can become live again.
    if (
        cell.usage == null &&
        LEGACY_BUNDLED_DEMO_CELL_IDS.has(canonicalEncCellId(cell.id)) &&
        LEGACY_BUNDLED_DEMO_FLAGS.some((key) => localStorage.getItem(key) === '1')
    ) {
        return false;
    }
    return true;
}

/** Cells that may be painted for reference. Demo/quarantined data stays out;
 * unsigned user packs can be displayed but never enter `listCells()`, the
 * safety-authority list used by routing and route verification. */
function isDisplayCell(cell: EncCell): boolean {
    if (cell.usage === 'demo') return false;
    if (cell.usage === 'pending') return false;
    if (cell.cloudManifestVersion !== undefined && cell.hazardCount === 0) return false;
    if (
        cell.usage == null &&
        LEGACY_BUNDLED_DEMO_CELL_IDS.has(canonicalEncCellId(cell.id)) &&
        LEGACY_BUNDLED_DEMO_FLAGS.some((key) => localStorage.getItem(key) === '1')
    ) {
        return false;
    }
    return true;
}

/** listCells memo — keyed to the version counter. With 172 cloud
 *  cells, every un-memoized call re-parsed ~86 KB of localStorage
 *  JSON, and hot paths (routing hazard batches, registration storms)
 *  issued it thousands of times (2026-07-12 audit). Callers must
 *  treat the returned array as READ-ONLY (copy before sorting). */
let listCache: { version: number; cells: EncCell[] } | null = null;
let displayListCache: { version: number; cells: EncCell[] } | null = null;
let pendingListCache: { version: number; cells: EncCell[] } | null = null;
let registeredListCache: { version: number; cells: EncCell[] } | null = null;

/** Read the registry as case-insensitive storage-identity groups. A native
 * case-insensitive filesystem can only hold ONE blob for each group; if old
 * metadata contains both navigation and reference/demo aliases, fail closed
 * to the lower authority instead of guessing which bytes occupy that file. */
function readIdentityGroups(): Map<string, EncCell[]> {
    const groups = new Map<string, EncCell[]>();
    for (const id of readIndex()) {
        const identity = encCellStorageIdentity(id);
        if (QUARANTINED_CELLS.has(identity)) continue;
        const cell = readCell(id);
        if (!cell) continue;
        const group = groups.get(identity);
        if (group) group.push(cell);
        else groups.set(identity, [cell]);
    }
    return groups;
}

function pickNavigationCell(group: EncCell[]): EncCell | null {
    if (group.some((cell) => cell.usage === 'reference' || cell.usage === 'pending' || cell.usage === 'demo')) {
        return null;
    }
    return (
        group.find((cell) => cell.id === canonicalEncCellId(cell.id) && isLiveNavigationCell(cell)) ??
        group.find(isLiveNavigationCell) ??
        null
    );
}

function pickDisplayCell(group: EncCell[]): EncCell | null {
    // Demo is the lowest authority: a legacy demo alias makes the shared blob
    // ineligible even when another stale alias calls it navigation/reference.
    if (group.some((cell) => cell.usage === 'demo')) return null;
    const reference = group.find((cell) => cell.usage === 'reference');
    if (reference) return isDisplayCell(reference) ? reference : null;
    if (group.some((cell) => cell.usage === 'pending')) return null;
    return (
        group.find((cell) => cell.id === canonicalEncCellId(cell.id) && isDisplayCell(cell)) ??
        group.find(isDisplayCell) ??
        null
    );
}

/** Lowest-authority record for one physical-file identity. This is the only
 * safe choice for mutation/reconciliation code when a legacy registry has
 * aliases that disagree about authority. */
function pickRegisteredCell(group: EncCell[]): EncCell | null {
    return (
        group.find((cell) => cell.usage === 'demo') ??
        group.find((cell) => cell.usage === 'reference') ??
        group.find((cell) => cell.usage === 'pending') ??
        group.find((cell) => cell.id === canonicalEncCellId(cell.id)) ??
        group[0] ??
        null
    );
}

/**
 * List every imported cell. Memoized per registry version — cheap to
 * call anywhere, including per-frame UI reads and routing loops.
 */
export function listCells(): EncCell[] {
    if (listCache && listCache.version === version) return listCache.cells;
    const out: EncCell[] = [];
    for (const group of readIdentityGroups().values()) {
        const cell = pickNavigationCell(group);
        if (cell) out.push(cell);
    }
    listCache = { version, cells: out };
    return out;
}

/** List cells that may be painted, including unsigned `reference` packs.
 * Never use this for routing, hazard clearance, saved-route verification or
 * Cast Off; those must continue using `listCells()` / `cellsForBBox()`. */
export function listDisplayCells(): EncCell[] {
    if (displayListCache && displayListCache.version === version) return displayListCache.cells;
    const out: EncCell[] = [];
    for (const group of readIdentityGroups().values()) {
        const cell = pickDisplayCell(group);
        if (cell) out.push(cell);
    }
    displayListCache = { version, cells: out };
    return out;
}

/** Manifest entries whose bytes are absent, stale or not yet validated.
 * They may trigger hydration, but must never paint or enter a safety query. */
export function listPendingCells(): EncCell[] {
    if (pendingListCache && pendingListCache.version === version) return pendingListCache.cells;
    const out: EncCell[] = [];
    for (const group of readIdentityGroups().values()) {
        const cell = pickRegisteredCell(group);
        if (
            cell &&
            (cell.usage === 'pending' ||
                (cell.cloudManifestVersion !== undefined && cell.hazardCount === 0 && cell.usage !== 'reference'))
        ) {
            out.push({ ...cell, usage: 'pending' });
        }
    }
    pendingListCache = { version, cells: out };
    return out;
}

/** Every valid registry identity, including pending/demo records. Mutation
 * and cloud-reconciliation code uses this; render/safety code must not. */
export function listRegisteredCells(): EncCell[] {
    if (registeredListCache && registeredListCache.version === version) return registeredListCache.cells;
    const out: EncCell[] = [];
    for (const group of readIdentityGroups().values()) {
        const cell = pickRegisteredCell(group);
        if (cell) out.push(cell);
    }
    registeredListCache = { version, cells: out };
    return out;
}

/**
 * Get one cell by ID. Null if not imported.
 */
export function getCell(id: string): EncCell | null {
    return pickNavigationCell(readIdentityGroups().get(encCellStorageIdentity(id)) ?? []);
}

/** Display-only lookup. Safety consumers must use `getCell`. */
export function getDisplayCell(id: string): EncCell | null {
    return pickDisplayCell(readIdentityGroups().get(encCellStorageIdentity(id)) ?? []);
}

/** Lowest-authority raw registry lookup for serialized mutations only. */
export function getRegisteredCell(id: string): EncCell | null {
    return pickRegisteredCell(readIdentityGroups().get(encCellStorageIdentity(id)) ?? []);
}

/**
 * Insert or update a cell record. Used by the import pipeline
 * after a successful S-57 → GeoJSON conversion. Notifies listeners
 * so the map ENC coverage overlay refreshes immediately.
 */
export function putCell(cell: EncCell, options: { allowAuthorityUpgrade?: boolean } = {}): void {
    const canonicalId = canonicalEncCellId(cell.id);
    if (!ENC_CELL_ID_PATTERN.test(canonicalId)) throw new Error(`Invalid ENC cell ID: ${cell.id}`);
    const identity = encCellStorageIdentity(canonicalId);
    const ids = readIndex();
    const aliases = ids.filter((id) => encCellStorageIdentity(id) === identity);
    const existingGroup = aliases.map(readCell).filter((stored): stored is EncCell => stored !== null);
    const existingLowerAuthority = existingGroup.find(
        (stored) => stored.usage === 'demo' || stored.usage === 'reference' || stored.usage === 'pending',
    );
    // Backward compatibility still treats a genuinely new/legacy untagged
    // record as navigation coverage. It must never, however, turn an existing
    // explicitly lower-authority record into navigation merely because a
    // metadata patch omitted `usage` (the cloud manifest path used to do
    // exactly that before verified bytes arrived).
    const inheritedLowerAuthority = existingLowerAuthority?.usage;
    const requestedUsage = cell.usage ?? inheritedLowerAuthority ?? 'navigation';
    const usage =
        inheritedLowerAuthority && requestedUsage === 'navigation' && !options.allowAuthorityUpgrade
            ? inheritedLowerAuthority
            : requestedUsage;
    const classified: EncCell = { ...cell, id: canonicalId, usage };
    const serialized = JSON.stringify(classified);

    // TRUE upsert (kill #41, 2026-08-12): a byte-identical re-record must
    // not write or notify. The sync passes (personalCellSync/cloud) re-assert
    // every cell's metadata on each lap; notify() bumps the registry version,
    // the version is baked into the merge cache key, so each no-op lap
    // invalidated EVERY cached merge — the fatal trail shows the same
    // 3-cell/8.1 MB window re-merged six times in 24 s, ~100 MB of parse
    // transient per lap, sawtoothing for 15 hours until WebKit reaped the
    // page. Identical in, nothing out: no write, no version bump, no
    // re-merge.
    if (
        aliases.length === 1 &&
        aliases[0] === canonicalId &&
        localStorage.getItem(recordKey(canonicalId)) === serialized
    ) {
        return;
    }

    localStorage.setItem(recordKey(classified.id), serialized);
    for (const alias of aliases) {
        if (alias !== classified.id) localStorage.removeItem(recordKey(alias));
    }
    const nextIds = ids.filter((id) => encCellStorageIdentity(id) !== identity);
    nextIds.push(classified.id);
    writeIndex(nextIds);
    notify();
}

/**
 * Remove a cell from the metadata index. Caller is responsible for
 * deleting the GeoJSON blob from the filesystem (EncCellStore).
 * Notifies listeners.
 */
export function removeCell(id: string): void {
    const canonicalId = canonicalEncCellId(id);
    if (!ENC_CELL_ID_PATTERN.test(canonicalId)) throw new Error(`Invalid ENC cell ID: ${id}`);
    const identity = encCellStorageIdentity(canonicalId);
    const ids = readIndex();
    for (const alias of ids) {
        if (encCellStorageIdentity(alias) === identity) localStorage.removeItem(recordKey(alias));
    }
    writeIndex(ids.filter((alias) => encCellStorageIdentity(alias) !== identity));
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

/** Display-only bbox selection. Safety consumers must use `cellsForBBox`. */
export function displayCellsForBBox(bbox: [number, number, number, number]): EncCell[] {
    const [qMinLon, qMinLat, qMaxLon, qMaxLat] = bbox;
    return listDisplayCells().filter((cell) => {
        const [cMinLon, cMinLat, cMaxLon, cMaxLat] = cell.bbox;
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

function emit(): void {
    for (const l of listeners) {
        try {
            l();
        } catch (err) {
            log.warn('listener threw', err);
        }
    }
}

// ── Notification batching ─────────────────────────────────────────
// A cloud-hydration walk lands 15-40 cells, and every arrival used to
// emit a listener notify. The registry version is in the merge cache
// key, so each one was a guaranteed miss → a full wide-band re-merge
// plus a 14-source Mapbox re-upload, every 0.8-3 s for the whole walk.
// That allocation churn is what OOM-killed the WebView on a long pan
// into un-synced coast (2026-07-20, SE QLD → GBR).
//
// CRITICAL: suspending coalesces the LISTENER CALLBACKS only. `version`
// still increments on every mutation — it invalidates the listCells
// memo and the merge cache key, so freezing it would serve stale cell
// lists and render the wrong chart. Correctness first, batching second.
let notifyDepth = 0;
let notifyPending = false;

/** Begin coalescing listener notifications. Re-entrant; pair with resume. */
export function suspendNotifications(): void {
    notifyDepth++;
}

/** Emit now if anything was coalesced — lets a long walk paint in waves. */
export function flushNotifications(): void {
    if (!notifyPending) return;
    notifyPending = false;
    emit();
}

/** End one suspension. The outermost resume flushes what's pending. */
export function resumeNotifications(): void {
    notifyDepth = Math.max(0, notifyDepth - 1);
    if (notifyDepth === 0) flushNotifications();
}

function notify(): void {
    version++;
    if (notifyDepth > 0) {
        notifyPending = true;
        return;
    }
    emit();
}

/**
 * Get the current version counter. Increments on every
 * putCell / removeCell / clearAllCellMetadata.
 */
export function getVersion(): number {
    return version;
}

/** Stable cross-session identity of the navigation chart library. Unlike the
 * in-memory version counter, this survives reloads and can be bound into a
 * saved Route Tracer verification envelope. */
export function getRegistryFingerprint(scope?: [number, number, number, number]): string {
    // Optional scope [west, south, east, north]: fingerprint only the cells
    // whose coverage intersects it. A route verification cares about the
    // charts UNDER THE ROUTE — with the full-library fingerprint, syncing a
    // Mackay cell invalidated a Newport route check the moment it landed
    // (Shane 2026-08-26: 'i get this message whenever i try to cast off…
    // i have checked and reapproved the route, same issue' — his Pi and
    // cloud sync churned cells hundreds of miles from the route).
    const cells = scope ? cellsForBBox(scope) : listCells();
    // Chart IDENTITY only: id + edition + issue date + size. Deliberately NOT
    // cloudManifestVersion — that is a DELIVERY artefact: every manifest
    // publication re-stamps every cloud cell with the new version
    // (cloudCellSync's needsRefresh walk), so including it meant the Pi
    // publishing ANY cell anywhere re-fingerprinted the whole library and
    // the Cast Off recheck loop survived even the route-scoped fix (Shane
    // 2026-08-26, second sighting). A real chart change moves edition,
    // issued or sizeBytes.
    return cells
        .map((cell) => `${cell.id}@${cell.edition}@${cell.issued}@${cell.sizeBytes ?? 'unknown'}`)
        .sort()
        .join('|');
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
