/**
 * ENC Cell Store — Capacitor Filesystem persistence for the
 * GeoJSON blobs produced by the Pi-side S-57 → GeoJSON converter.
 *
 * One file per cell at `Directory.Data/enc-cells/<cellId>.geojson`.
 * Files run ~0.5 MB median, ~7.6 MB largest across the measured AU corpus
 * (2026-07-16; a busy harbour cell is the top end), so we deliberately
 * keep them on the filesystem rather than in
 * IndexedDB or localStorage (both of which have origin-quota
 * limits we'd hit on a power-user fleet).
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

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import type { EncConversionResult } from './types';
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

const DIRECTORY = Directory.Data;

function relPath(cellId: string): string {
    // Metadata, cache keys and filenames MUST share the same case-insensitive
    // identity. Apple filesystems are normally case-insensitive, so preserving
    // caller case here allowed `au...` and `AU...` metadata records to address
    // one physical file while the JS cache treated them as different cells.
    const canonical = canonicalEncCellId(cellId);
    if (!ENC_CELL_ID_PATTERN.test(canonical)) throw new Error(`Invalid ENC cell ID: ${cellId}`);
    return `${ENC_GEOJSON_DIR}/${encCellStorageIdentity(canonical)}.geojson`;
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
                await Filesystem.stat({ path: ENC_GEOJSON_DIR, directory: DIRECTORY });
                return;
            } catch {
                /* missing — create below */
            }
            try {
                await Filesystem.mkdir({ path: ENC_GEOJSON_DIR, directory: DIRECTORY, recursive: true });
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

/** The budget in force, for tests and the [perf] line. */
export function blobCacheBudgetBytes(): number {
    return blobBudgetBytes;
}

export function blobCacheStats(): { entries: number; textMB: number } {
    return { entries: blobCache.size, textMB: Math.round((blobCacheBytes / 1048576) * 10) / 10 };
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
): Promise<{ path: string; sizeBytes: number }> {
    const normalizedBlob = normalizeBlobForCell(cellId, blob);
    if (!normalizedBlob) {
        throw new Error(`ENC blob identity does not match requested cell ${cellId}`);
    }
    await ensureDir();
    const path = relPath(cellId);
    const data = JSON.stringify(normalizedBlob);
    const sizeBytes = utf8ByteLength(data, ENC_CELL_BLOB_MAX_BYTES);
    if (sizeBytes > ENC_CELL_BLOB_MAX_BYTES) {
        throw new Error(
            `ENC cell ${canonicalEncCellId(cellId)} is ${(sizeBytes / 1_048_576).toFixed(1)} MB; ` +
                `the per-cell limit is ${ENC_CELL_BLOB_MAX_BYTES / 1_048_576} MB.`,
        );
    }
    await Filesystem.writeFile({
        path,
        data,
        directory: DIRECTORY,
        encoding: Encoding.UTF8,
    });
    // We hold the fresh parsed blob right here — cache it instead of
    // forcing the next merge to re-read + re-parse what we just wrote.
    cacheBlob(cellId, normalizedBlob, sizeBytes);
    log.info(`saved cell ${cellId} → ${path} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    return { path, sizeBytes };
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
    try {
        const result = await Filesystem.readFile({
            path: relPath(cellId),
            directory: DIRECTORY,
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
    if (touchBlob(cellId)) return true;
    try {
        await Filesystem.stat({ path: relPath(cellId), directory: DIRECTORY });
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
 *   2. the cloud bucket (desktop builder, Phase 5 — hydrates on demand).
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
        // Rung 2: the cloud bucket.
        const { downloadCloudCell } = await import('./cloudCellSync');
        if (await downloadCloudCell(cellId)) return loadCellGeoJSON(cellId, false);
        // Rung 3: the skipper's OWN published cells. Last because it is the
        // narrowest — it only ever has what this account uploaded — and
        // because the curated copy of a shared cell is the cheaper fetch.
        // This is the rung that serves a browser off the boat: no Pi on the
        // LAN, nothing curated for Nouméa or Port Vila, but the owner's cells
        // are one signed-in download away.
        const { downloadPersonalCell } = await import('./personalCellSync');
        if (await downloadPersonalCell(cellId)) return loadCellGeoJSON(cellId, false);
    }
    return null;
}

/**
 * Delete a cell's GeoJSON blob. Idempotent — succeeds even if the
 * file is missing.
 */
export async function deleteCellGeoJSON(cellId: string): Promise<void> {
    dropBlob(cellId);
    try {
        await Filesystem.deleteFile({
            path: relPath(cellId),
            directory: DIRECTORY,
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
    dirEnsured = null; // rmdir below deletes the dir — next save must recreate it
    try {
        await Filesystem.rmdir({
            path: ENC_GEOJSON_DIR,
            directory: DIRECTORY,
            recursive: true,
        });
        log.info('cleared all ENC GeoJSON blobs');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT/i.test(msg)) return;
        log.warn('clearAllGeoJSON failed', err);
    }
}
