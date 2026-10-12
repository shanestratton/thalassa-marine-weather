/**
 * ENC Cell Store — where the GeoJSON blobs produced by the Pi-side
 * S-57 → GeoJSON converter are held. Two stores, by licence (127-C-c):
 *
 *  - Licensed (protected) cells live in memory only, in boatCellVault:
 *    licensed cells never touch the disk. o-charts (Roberto, 2026-10-10):
 *    "Storing unencrypted data on any medium, and especially in the cloud, is
 *    strictly prohibited by the terms of the licenses signed with the chart
 *    providers." The boat's Pi refills them (piCellSync).
 *  - Open (NOAA) cells keep a file each: on iOS at
 *    `Directory.Library/Application Support/enc-open/<cellId>.geojson`,
 *    excluded from backup (prepareChartStore); on the web at
 *    `Directory.Data/enc-cells` (IndexedDB). On iOS Directory.Data is the
 *    Documents folder older builds used; storeReady() moves the open cells out
 *    and deletes everything else there, once per launch until it is gone.
 *
 * Files run ~0.5 MB median, ~7.6 MB largest across the measured AU corpus
 * (2026-07-16; a busy harbour cell is the top end).
 *
 * The blob shape is the union of layer FeatureCollections returned
 * by the Pi conversion endpoint. The EncHazardService is
 * responsible for parsing this back into EncHazard records.
 *
 * Public API:
 *  - saveCellGeoJSON(cellId, blob) → relative filesystem path
 *  - loadCellGeoJSON(cellId)       → parsed JSON or null
 *  - deleteCellGeoJSON(cellId)     → idempotent delete
 *  - clearAllGeoJSON()             → delete the entire directory
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import { prepareChartStore, purgeWebDiskCache } from '../nativeStorage';
import * as vault from './boatCellVault';
import { chartLicenceOf, isOpenChartCell } from './chartLicence';
import { listRegisteredCells, putCell } from './EncCellMetadata';
import type { ChartLicence, EncConversionResult } from './types';
import {
    canonicalEncCellId,
    ENC_CELL_BLOB_MAX_BYTES,
    ENC_CELL_ID_PATTERN,
    ENC_GEOJSON_DIR,
    encCellStorageIdentity,
    utf8ByteLength,
} from './types';

const log = createLogger('EncCellStore');

// ── Helpers ────────────────────────────────────────────────────────

/** The open (NOAA) store on iOS; Directory.Data there is Documents, the old store. */
const OPEN_DIR_NATIVE = 'Application Support/enc-open';
const native = (): boolean => Capacitor.isNativePlatform();
const openDir = (): string => (native() ? OPEN_DIR_NATIVE : ENC_GEOJSON_DIR);
const openDirectory = (): Directory => (native() ? Directory.Library : Directory.Data);
const isOpenId = (cellId: string): boolean => isOpenChartCell({ id: cellId });

function relPath(cellId: string): string {
    // Metadata, cache keys and filenames MUST share the same case-insensitive
    // identity. Apple filesystems are normally case-insensitive, so preserving
    // caller case here allowed `au...` and `AU...` metadata records to address
    // one physical file while the JS cache treated them as different cells.
    const canonical = canonicalEncCellId(cellId);
    if (!ENC_CELL_ID_PATTERN.test(canonical)) throw new Error(`Invalid ENC cell ID: ${cellId}`);
    return `${openDir()}/${encCellStorageIdentity(canonical)}.geojson`;
}

// ── The launch sweep (127-C-c decision 5) ──────────────────────────
// One per launch, idempotent, no "done" flag: a run cut short by a kill
// finishes on the next. It replaces the 127 upgrade purge and the deferred
// 126-20 launch purge. Every store call awaits it first.
let ready: Promise<void> | null = null;
const WEBKIT_PURGED_KEY = 'thalassa_webkit_cache_purged_v1';

export function storeReady(): Promise<void> {
    return (ready ??= sweepOldStore().catch((err) => log.warn('enc store sweep failed', err)));
}

async function sweepOldStore(): Promise<void> {
    const ios = native();
    if (ios) await prepareChartStore().catch((err) => log.warn('prepareChartStore failed', err));
    await sweepDocuments(ios);
    if (!ios) return;
    // Chart pictures older builds may have left in WebKit's HTTP cache (127-C-b
    // decision 11). The flag is set only after the call resolves.
    try {
        if (localStorage.getItem(WEBKIT_PURGED_KEY) === '1') return;
        await purgeWebDiskCache();
        localStorage.setItem(WEBKIT_PURGED_KEY, '1');
    } catch (err) {
        log.warn('purgeWebDiskCache failed; retried next launch', err);
    }
}

async function sweepDocuments(ios: boolean): Promise<void> {
    const old = { path: ENC_GEOJSON_DIR, directory: Directory.Data };
    try {
        await Filesystem.stat(old);
    } catch {
        return;
    }
    // The registry has already dropped every record that is not open (its own
    // sweep, on first access). An unsigned reference pack is not provably open.
    const open = new Map(
        listRegisteredCells()
            .filter((cell) => cell.usage !== 'reference' && isOpenChartCell(cell))
            .map((cell) => [encCellStorageIdentity(cell.id), cell]),
    );
    const names = (await Filesystem.readdir(old)).files.map((file) => (typeof file === 'string' ? file : file.name));
    if (!ios) {
        // The web's open store IS this folder: delete the rest, file by file.
        let removed = 0;
        for (const name of names) {
            if (open.has(encCellStorageIdentity(name.replace(/\.geojson$/i, '')))) continue;
            await Filesystem.deleteFile({ path: `${ENC_GEOJSON_DIR}/${name}`, directory: Directory.Data }).catch(
                () => undefined,
            );
            removed += 1;
        }
        log.warn(`enc store: removed ${removed} licensed, kept ${names.length - removed} open`);
        return;
    }
    // Build 102's "move" deleted the only copy because both folders were one
    // place (LocalDatabase.ts): delete nothing unless the platform says they differ.
    const [from, to] = await Promise.all([
        Filesystem.getUri(old),
        Filesystem.getUri({ path: OPEN_DIR_NATIVE, directory: Directory.Library }),
    ]);
    if (!from.uri || from.uri === to.uri) {
        log.warn('enc store: old and new chart folders are one place; nothing moved or deleted');
        return;
    }
    let moved = 0;
    for (const [identity, cell] of open) {
        const file = `${identity}.geojson`;
        try {
            await Filesystem.rename({
                from: `${ENC_GEOJSON_DIR}/${file}`,
                directory: Directory.Data,
                to: `${OPEN_DIR_NATIVE}/${file}`,
                toDirectory: Directory.Library,
            });
            moved += 1;
        } catch {
            // Already moved by a run that was cut short? Otherwise it re-hydrates.
            const there = await Filesystem.stat({
                path: `${OPEN_DIR_NATIVE}/${file}`,
                directory: Directory.Library,
            }).then(
                () => true,
                () => false,
            );
            if (!there) putCell({ ...cell, usage: 'pending' });
        }
    }
    // Every licensed file and every orphan, in one native call.
    await Filesystem.rmdir({ ...old, recursive: true });
    log.warn(`enc store: removed ${names.length - moved} licensed, moved ${moved} open`);
}

function normalizeBlobForCell(cellId: string, value: unknown): EncConversionResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<EncConversionResult>;
    const blobCellId = candidate.cellId;
    if (typeof blobCellId !== 'string') return null;
    const expected = canonicalEncCellId(cellId);
    const actual = canonicalEncCellId(blobCellId);
    if (
        !ENC_CELL_ID_PATTERN.test(expected) ||
        !ENC_CELL_ID_PATTERN.test(actual) ||
        encCellStorageIdentity(expected) !== encCellStorageIdentity(actual) ||
        !candidate.layers ||
        typeof candidate.layers !== 'object' ||
        Array.isArray(candidate.layers) ||
        !Array.isArray(candidate.bbox) ||
        candidate.bbox.length !== 4 ||
        !candidate.bbox.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) ||
        typeof candidate.sourceHO !== 'string' ||
        !Number.isInteger(candidate.edition) ||
        typeof candidate.issued !== 'string'
    ) {
        return null;
    }
    return (actual === blobCellId ? candidate : { ...candidate, cellId: actual }) as EncConversionResult;
}

function textWithinCellLimit(text: string): boolean {
    // JSON cell payloads are overwhelmingly ASCII. The cheap code-unit check
    // runs before worker transfer/JSON.parse; the exact UTF-8 check on save
    // protects the uncommon non-ASCII case without allocating an extra 32 MB
    // buffer on every read.
    return (
        text.length <= ENC_CELL_BLOB_MAX_BYTES &&
        utf8ByteLength(text, ENC_CELL_BLOB_MAX_BYTES) <= ENC_CELL_BLOB_MAX_BYTES
    );
}

/**
 * Ensure the parent directory exists. Capacitor's `writeFile`
 * requires the directory to exist; we create it lazily on first
 * write rather than at app-init time so we don't pay the cost when
 * no ENCs are imported.
 */
let dirEnsured: Promise<void> | null = null;

function ensureDir(): Promise<void> {
    // Memoized + stat-probed: the iOS Filesystem plugin logs the
    // already-exists mkdir rejection NATIVELY (OS-PLUG-FILE-0010) before JS
    // can catch it, and saveCellGeoJSON runs once per cell — a 20-cell Pi
    // sync used to print 20 error lines. stat succeeds silently when the
    // dir exists, so mkdir only runs when it's genuinely missing.
    if (!dirEnsured) {
        dirEnsured = (async () => {
            try {
                await Filesystem.stat({ path: openDir(), directory: openDirectory() });
                return;
            } catch {
                /* missing — create below */
            }
            try {
                await Filesystem.mkdir({ path: openDir(), directory: openDirectory(), recursive: true });
            } catch (err) {
                // Lost a create race — swallow; anything else is real.
                const msg = err instanceof Error ? err.message : String(err);
                if (!/exist/i.test(msg)) {
                    log.warn('ensureDir failed', err);
                    dirEnsured = null; // retry on the next save
                    throw err;
                }
            }
        })();
    }
    return dirEnsured;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Parsed-blob memory cache (2026-07-11, Shane: "it seems to take a
 * long time for our new layer to show up"). Every render merge used
 * to re-read + re-JSON.parse EVERY cell from disk — and a cell-sync
 * storm triggers many merges back to back. Geometry objects are
 * shared into the merged FeatureCollections anyway (properties get
 * cloned, geometry doesn't), so caching the parsed blob costs little
 * beyond what the merge already retains. Invalidated on save/delete.
 */
const blobCache = new Map<string, { blob: EncConversionResult; sizeBytes: number }>();

/** LRU caps (2026-07-12): unbounded, the cache held all 172 parsed
 *  cells (~210 MB of JSON text, several × that as JS heap) and desktop
 *  Chrome's renderer OOM-died. The first fix capped ENTRY COUNT only —
 *  and a count cap alone can pin unbounded heap if cells are large, so
 *  it was the wrong bound (2026-07-12 audit, MAJOR). Eviction now respects a
 *  BYTE budget (JSON text length; JS heap runs a few × this) as well
 *  as the count. A handful of most-recent entries are always kept so
 *  one oversized cell can't thrash itself out of its own render loop.
 *  Map iteration order = insertion order; touchBlob() re-inserts on
 *  hit so eviction is least-recently-USED. */
// Real AU corpus (measured 2026-07-16): median cell ~0.5 MB, LARGEST ~7.6 MB
// — nothing like the hypothetical "50 MB" the old note guessed. So the BYTE
// budget is the memory bound that matters; the count cap just kept the LRU
// from growing unboundedly. At 32 the count bound bit first for these small
// cells (~16 MB of 0.5 MB cells) and evicted/re-parsed history the 48 MB
// budget had room for. Raised to 128 so the 48 MB byte cap is the real
// bound: the same peak memory now retains far more recently-panned cells,
// cutting the JSON.parse re-parse churn on a wide coastal pan. Memory is
// unchanged — BLOB_CACHE_MAX_BYTES is untouched.
const BLOB_CACHE_MAX = 128;
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024; // JSON text — heap ≈ few ×
const BLOB_CACHE_MIN_KEEP = 4;
let blobCacheBytes = 0;

/**
 * The budget while the skipper is PLOTTING. 2026-08-09, from Shane's log
 * rather than from a guess:
 *
 *     [WebContentKill] the web layer died in the foreground 3x on this install;
 *     most recently on 'map'
 *
 * 'map' with the tracer running IS the planning screen — the Plan tab stays
 * lit while the chart handles the drawing. So the foreground kills are landing
 * on chart + ENC + tracer, which is the combination 0a607bd3 already tried to
 * relieve by deferring the Pi sync. That helped and was not enough, and that
 * commit named this cache as the next suspect: 48 MB of JSON text at ~3×
 * parsed is ~150 MB resident, on top of Mapbox GL, while the tracer allocates
 * per stroke.
 *
 * 16 MB is roughly five average AU cells (median ~0.5 MB, largest measured
 * 7.6 MB) — enough for the visible area and its neighbours. The cost is
 * re-parsing sooner on a wide pan; the alternative is the process dying, which
 * costs the whole leg. Restored the moment the tracer stops.
 */
const BLOB_CACHE_PLOTTING_BYTES = 16 * 1024 * 1024;

/** The budget currently in force. */
let blobBudgetBytes = BLOB_CACHE_MAX_BYTES;

/** Cache occupancy, for the [perf] merge line. The byte figure is JSON TEXT
 *  length — measured parsed heap runs ~3× it, so a full 48 MB cache is
 *  ~150 MB resident, and eviction does NOT free a cell whose geometry a
 *  cached merge still references (mergeFold pushes geometry by reference).
 *  Logging it per merge is how we find out whether a long pan actually fills
 *  this, rather than assuming. */
/**
 * Tighten or restore the byte budget, and evict down to it immediately.
 *
 * Immediately matters: shrinking the cap without evicting would leave the
 * existing 45 MB resident until the next cell happened to be cached, which on
 * a stationary chart could be never — and the whole point is to give memory
 * back BEFORE the skipper starts drawing.
 */
export function setBlobCachePlottingMode(plotting: boolean): void {
    blobBudgetBytes = plotting ? BLOB_CACHE_PLOTTING_BYTES : BLOB_CACHE_MAX_BYTES;
    while (shouldEvictBlob(blobCache.size, blobCacheBytes, BLOB_CACHE_MAX, blobBudgetBytes)) {
        const oldest = blobCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropBlob(oldest);
    }
}

/**
 * Give the parsed cells back between background route checks (125-07): evict
 * down to the min-keep floor, budget unchanged. Each cold check window loads
 * its corridor's cells; nothing on the Log page draws them, and a merge that
 * still references a cell's geometry keeps it alive regardless. Returns how
 * many were dropped.
 */
export function releaseBlobCache(): number {
    let dropped = 0;
    while (shouldEvictBlob(blobCache.size, blobCacheBytes, 0, 0)) {
        const oldest = blobCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropBlob(oldest);
        dropped += 1;
    }
    return dropped;
}

/** The budget in force, for tests and the [perf] line. */
export function blobCacheBudgetBytes(): number {
    return blobBudgetBytes;
}

export function blobCacheStats(): { entries: number; textMB: number } {
    return { entries: blobCache.size, textMB: Math.round((blobCacheBytes / 1048576) * 10) / 10 };
}

/** Unpair or sign-out (127-C-c decision 9): forget every licensed cell held in memory. */
export function clearProtectedBlobs(): void {
    for (const key of [...blobCache.keys()]) if (!isOpenId(key)) dropBlob(key);
    vault.clear();
}

/** An iOS memory warning: the parse cache goes, the vault keeps half. */
export function shedCellMemory(): void {
    blobCache.clear();
    blobCacheBytes = 0;
    vault.trim(0.5);
}

/** Eviction decision for the blob LRU — pure so the caps interplay is
 *  unit-tested. Evict the oldest while over EITHER cap, but never below the
 *  min-keep floor (so a working set of a few cells can't thrash itself out
 *  of its own render loop, even if one is oversized). */
export function shouldEvictBlob(
    count: number,
    bytes: number,
    max = BLOB_CACHE_MAX,
    maxBytes = BLOB_CACHE_MAX_BYTES,
    minKeep = BLOB_CACHE_MIN_KEEP,
): boolean {
    return count > minKeep && (count > max || bytes > maxBytes);
}

function touchBlob(cellId: string): EncConversionResult | undefined {
    const key = encCellStorageIdentity(cellId);
    const hit = blobCache.get(key);
    if (hit) {
        blobCache.delete(key);
        blobCache.set(key, hit);
    }
    return hit?.blob;
}

function dropBlob(cellId: string): void {
    const key = encCellStorageIdentity(cellId);
    const hit = blobCache.get(key);
    if (hit) {
        blobCacheBytes -= hit.sizeBytes;
        blobCache.delete(key);
    }
}

function cacheBlob(cellId: string, blob: EncConversionResult, sizeBytes: number): void {
    const key = encCellStorageIdentity(cellId);
    dropBlob(key);
    blobCache.set(key, { blob, sizeBytes });
    blobCacheBytes += sizeBytes;
    while (shouldEvictBlob(blobCache.size, blobCacheBytes, BLOB_CACHE_MAX, blobBudgetBytes)) {
        const oldest = blobCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropBlob(oldest);
    }
}

/**
 * Save the converted GeoJSON for a cell. Returns the relative path
 * the caller should persist in the cell metadata record, plus the
 * serialized byte length — importCell used to re-stringify the whole
 * multi-MB blob a second time just to measure it (2026-07-12 audit:
 * ~80 MB of transient UTF-16 per big cell, twice, on the UI thread).
 *
 * Overwrites if the file already exists (used when the user
 * re-imports an updated edition of the same cell).
 */
export async function saveCellGeoJSON(
    cellId: string,
    blob: EncConversionResult,
    assertAuthority?: () => void,
    licence?: ChartLicence,
): Promise<{ path: string; sizeBytes: number }> {
    const normalizedBlob = normalizeBlobForCell(cellId, blob);
    if (!normalizedBlob) {
        throw new Error(`ENC blob identity does not match requested cell ${cellId}`);
    }
    const data = JSON.stringify(normalizedBlob);
    const sizeBytes = utf8ByteLength(data, ENC_CELL_BLOB_MAX_BYTES);
    if (sizeBytes > ENC_CELL_BLOB_MAX_BYTES) {
        throw new Error(
            `ENC cell ${canonicalEncCellId(cellId)} is ${(sizeBytes / 1_048_576).toFixed(1)} MB; ` +
                `the per-cell limit is ${ENC_CELL_BLOB_MAX_BYTES / 1_048_576} MB.`,
        );
    }
    assertAuthority?.();
    // The string built above goes to the vault as it is: no second stringify.
    let path = 'vault';
    if (chartLicenceOf({ id: cellId, sourceHO: normalizedBlob.sourceHO, licence }) === 'protected')
        vault.put(cellId, data);
    else path = await writeOpenCellText(cellId, data);
    // We hold the fresh parsed blob right here — cache it instead of
    // forcing the next merge to re-read + re-parse what we just wrote.
    cacheBlob(cellId, normalizedBlob, sizeBytes);
    log.info(`saved cell ${cellId} → ${path} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    return { path, sizeBytes };
}

/** The one disk write for chart cells, open (NOAA) cells only: a licensed cell reaching it throws. */
export async function writeOpenCellText(cellId: string, data: string): Promise<string> {
    if (!isOpenId(cellId))
        throw new Error(`${cellId} is a licensed chart: held in memory only, never written to disk.`);
    await storeReady();
    await ensureDir();
    const path = relPath(cellId);
    await Filesystem.writeFile({ path, data, directory: openDirectory(), encoding: Encoding.UTF8 });
    return path;
}

/** Raw read for the merge's read-ahead pipeline (z10-boot audit #11): the
 *  Capacitor bridge read is true async IO, so several can overlap while the
 *  caller parses serially under its time-slicer. LRU hit → the parsed blob
 *  directly (no read, no parse); miss → the file TEXT (caller parses via
 *  parseAndCacheCellText); absent/unreadable → missing. NO remote fallback —
 *  this is the paint-what's-local path. */
export async function readCellRaw(
    cellId: string,
): Promise<
    | { kind: 'cached'; blob: EncConversionResult }
    | { kind: 'text'; text: string }
    | { kind: 'missing'; notFound: boolean }
> {
    const cached = touchBlob(cellId);
    if (cached) return { kind: 'cached', blob: cached };
    const held = await vault.getText(cellId);
    if (held !== null) return { kind: 'text', text: held };
    // A licensed cell not in memory is missing: the Pi rung refills it.
    if (!isOpenId(cellId)) return { kind: 'missing', notFound: true };
    try {
        await storeReady();
        const result = await Filesystem.readFile({
            path: relPath(cellId),
            directory: openDirectory(),
            encoding: Encoding.UTF8,
        });
        const text = typeof result.data === 'string' ? result.data : await result.data.text();
        return { kind: 'text', text };
    } catch (err) {
        // notFound distinguishes ENOENT (remote ladder may hydrate) from a
        // real read error (loadCellGeoJSON warns + stays local).
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'missing', notFound: /not exist|ENOENT|File does not exist/i.test(msg) };
    }
}

// ── Off-thread parse (closing audit: indivisible multi-MB JSON.parse) ──
let parseWorker: Worker | null = null;
let parseWorkerBroken = false;
let parseSeq = 0;
const parseWaiters = new Map<number, (blob: unknown) => void>();

function getParseWorker(): Worker | null {
    if (parseWorkerBroken) return null;
    if (parseWorker) return parseWorker;
    if (typeof Worker === 'undefined') return null;
    try {
        parseWorker = new Worker(new URL('./encParseWorker.ts', import.meta.url), { type: 'module' });
    } catch {
        parseWorkerBroken = true;
        return null;
    }
    parseWorker.onerror = () => {
        parseWorkerBroken = true;
        parseWorker = null;
        // Resolve every waiter null — callers fall back to the sync parse.
        for (const resolve of parseWaiters.values()) resolve(null);
        parseWaiters.clear();
    };
    parseWorker.onmessage = (ev: MessageEvent<{ seq: number; blob: unknown | null }>) => {
        const resolve = parseWaiters.get(ev.data.seq);
        if (resolve) {
            parseWaiters.delete(ev.data.seq);
            resolve(ev.data.blob);
        }
    };
    return parseWorker;
}

/** Async parse: the WORKER pays the multi-MB JSON.parse; the main thread
 *  pays only the (much cheaper) structured clone in. Falls back to the
 *  sync path when workers are unavailable or the worker died. Same
 *  shape-gate + LRU-cache semantics as parseAndCacheCellText. */
export async function parseAndCacheCellTextAsync(cellId: string, text: string): Promise<EncConversionResult | null> {
    if (!textWithinCellLimit(text)) {
        log.warn(`parseAndCacheCellTextAsync ${cellId}: blob exceeds the per-cell limit`);
        return null;
    }
    const worker = getParseWorker();
    if (!worker) return parseAndCacheCellText(cellId, text);
    const blob = await new Promise<unknown>((resolve) => {
        const seq = ++parseSeq;
        parseWaiters.set(seq, resolve);
        try {
            worker.postMessage({ seq, cellId, text });
        } catch {
            parseWaiters.delete(seq);
            resolve(null);
        }
    });
    if (!blob || typeof blob !== 'object' || !(blob as EncConversionResult).cellId) {
        // Worker path failed/malformed — one sync retry keeps behaviour
        // identical to the old path (and logs there).
        return parseAndCacheCellText(cellId, text);
    }
    const parsed = normalizeBlobForCell(cellId, blob);
    if (!parsed) {
        log.warn(`parseAndCacheCellTextAsync ${cellId}: blob identity mismatch`);
        return null;
    }
    cacheBlob(cellId, parsed, text.length);
    return parsed;
}

/** Generic off-thread JSON.parse of an arbitrary blob, reusing the cell parse
 *  worker (closing audit 2026-07-18: the cloud-download path ran a bare
 *  main-thread JSON.parse of every 2-8 MB bucket blob, 3-wide, exactly the
 *  indivisible-stall class this worker retired on the LOAD path). Returns the
 *  raw parsed value — no shape gate, no cache, so it also handles the Pi's
 *  { cells: [...] } wrapper the cloud sync must unwrap. Falls back to a
 *  synchronous parse when the worker is unavailable or died; THROWS on
 *  malformed JSON either way, so callers keep their existing try/catch. */
export async function parseJsonOffThread(text: string): Promise<unknown> {
    const worker = getParseWorker();
    if (!worker) return JSON.parse(text);
    const blob = await new Promise<unknown>((resolve) => {
        const seq = ++parseSeq;
        parseWaiters.set(seq, resolve);
        try {
            worker.postMessage({ seq, cellId: '(json)', text });
        } catch {
            parseWaiters.delete(seq);
            resolve(null);
        }
    });
    // The worker posts null on a parse failure OR resolves waiters null when it
    // dies; a sync retry disambiguates — it throws on genuinely bad JSON and
    // succeeds if only the worker was gone.
    return blob === null ? JSON.parse(text) : blob;
}

/** The serial half of the pipeline: parse + shape-gate + LRU-cache one cell's
 *  text (exactly loadCellGeoJSON's semantics). Null on malformed. */
export function parseAndCacheCellText(cellId: string, text: string): EncConversionResult | null {
    try {
        if (!textWithinCellLimit(text)) {
            log.warn(`parseAndCacheCellText ${cellId}: blob exceeds the per-cell limit`);
            return null;
        }
        const parsed = normalizeBlobForCell(cellId, JSON.parse(text));
        if (!parsed) {
            log.warn(`parseAndCacheCellText ${cellId}: malformed JSON or blob identity mismatch`);
            return null;
        }
        cacheBlob(cellId, parsed, text.length);
        return parsed;
    } catch (err) {
        log.warn(`parseAndCacheCellText ${cellId} failed`, err);
        return null;
    }
}

/**
 * Cheap existence probe: is this cell's blob on the device (or already in the
 * parse cache)? Filesystem.stat only — no read, no JSON.parse — so the
 * corridor prefetch can scan a whole route's cells without touching the ones
 * that are already local.
 */
export async function hasCellGeoJSON(cellId: string): Promise<boolean> {
    if (touchBlob(cellId) || vault.has(cellId)) return true;
    if (!isOpenId(cellId)) return false;
    try {
        await storeReady();
        await Filesystem.stat({ path: relPath(cellId), directory: openDirectory() });
        return true;
    } catch {
        return false;
    }
}

/**
 * Load and parse the GeoJSON for a cell. Returns null if the file
 * is missing or malformed. A missing blob climbs the remote ladder ONCE:
 *   1. the boat's Pi (LAN — fast, free, works fully offline; unreachable
 *      from the HTTPS web page, where downloadPiCell fails instantly), then
 *   2. the cloud bucket (desktop builder, Phase 5 — hydrates on demand), for
 *      public-domain NOAA cells only since 126-20: licensed charts never
 *      come from the cloud, so a licensed cell missing here stays missing
 *      until the Pi has it.
 * Two rungs and no third: the personal cloud shelf that once followed them
 * was deleted in 127.
 * `remoteFallback=false` marks the post-download retry so a bad blob can't
 * loop the ladder forever.
 */
export async function loadCellGeoJSON(cellId: string, remoteFallback = true): Promise<EncConversionResult | null> {
    // COMPOSED from the pipeline halves (closing audit: this body was a
    // third hand-written copy of readCellRaw + parseAndCacheCellText —
    // three parse/shape-gate/cache sites to keep in sync).
    const raw = await readCellRaw(cellId);
    if (raw.kind === 'cached') return raw.blob;
    if (raw.kind === 'text') return parseAndCacheCellTextAsync(cellId, raw.text);
    if (!raw.notFound) {
        log.warn(`loadCellGeoJSON ${cellId} failed (read error, staying local)`);
        return null;
    }
    if (remoteFallback) {
        // Rung 1: the boat's Pi. importCell persists + warms the parse
        // cache, so the retry read is a cache hit. No-ops in <1 ms when
        // the Pi probe says unreachable (off the boat / HTTPS web).
        const { downloadPiCell } = await import('./piCellSync');
        if (await downloadPiCell(cellId)) return loadCellGeoJSON(cellId, false);
        // Rung 2: the cloud bucket (NOAA cells only; refuses others before
        // any request).
        const { downloadCloudCell } = await import('./cloudCellSync');
        if (await downloadCloudCell(cellId)) return loadCellGeoJSON(cellId, false);
    }
    return null;
}

/**
 * Delete a cell's GeoJSON blob. Idempotent — succeeds even if the
 * file is missing.
 */
export async function deleteCellGeoJSON(cellId: string): Promise<void> {
    dropBlob(cellId);
    vault.drop(cellId);
    if (!isOpenId(cellId)) return;
    try {
        await storeReady();
        await Filesystem.deleteFile({
            path: relPath(cellId),
            directory: openDirectory(),
        });
        log.info(`deleted cell ${cellId}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT|File does not exist/i.test(msg)) return;
        log.warn(`deleteCellGeoJSON ${cellId} failed`, err);
    }
}

/**
 * Wipe the entire ENC GeoJSON directory. Used by "reset all
 * charts" admin action and by tests.
 */
export async function clearAllGeoJSON(): Promise<void> {
    blobCache.clear();
    blobCacheBytes = 0;
    vault.clear();
    dirEnsured = null; // rmdir below deletes the dir — next save must recreate it
    try {
        await storeReady();
        await Filesystem.rmdir({
            path: openDir(),
            directory: openDirectory(),
            recursive: true,
        });
        log.info('cleared all ENC GeoJSON blobs');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT/i.test(msg)) return;
        log.warn('clearAllGeoJSON failed', err);
    }
}
