/**
 * The offline water pack on the phone (Phase 2b, 2026-10-01): the OSM
 * overlay tiles (waterPackTiles) saved under Capacitor Directory.Data — as
 * the ENC cells are (EncCellStore), not Cache, which iOS may purge — so a
 * passage planned online can be routed again with no signal (owner decision
 * 2: the offline Newport canal routes WHEN its water is on the phone).
 *
 * Layout:
 *   water-pack/z20/index.json      every tile the pack knows, empty ones too
 *   water-pack/z20/t/<key>.json    {schema, recipe, key, fetchedAt, savedAt,
 *                                   source, verified, overlay} — non-empty only
 *
 * The rules that keep a good pack good (tests/waterPack/WaterPackStore.test.ts):
 *   R1  an all-empty overlay never replaces a tile that has features — an
 *       empty reply is what a failure used to look like (the Pi's empty 200);
 *   R2  an unverified source (a pre-2b Pi, the Pi's stale copy, an old disk
 *       copy) only fills tiles the pack does not have;
 *   R3  a verified source (the Pi fresh or cached, the cloud) replaces a tile
 *       when it is at least as new; unchanged content only moves the dates.
 *
 * iOS runs every plugin call on ONE serial bridge queue (the 7.2 s cache-read
 * stall), so the store is frugal with it: the index lives in memory and is
 * flushed debounced; only changed tiles are written, 8 per tick with a yield,
 * at most 150 per fill (nearest the route's ends first); empty tiles live in
 * the index alone; a route reads at most 400 tile files. Over 40 MB the least
 * recently used tiles go, never the ones the current fill just saved.
 *
 * Before 2b the phone kept one osm-overlay/<rounded bbox>.json per route bbox
 * and read it back offline for that exact bbox only. Those copies are
 * imported once, on the pack's first load (non-empty ones with every class,
 * newest 20, within 30 s; dated by the file's mtime; unverified, so they only
 * fill tiles the pack lacks), and then neither written nor read again.
 *
 * Fix-up (2026-10-02):
 *   - an unverified fill saves only tiles with features, never an empty tile
 *     it cannot vouch for (a pre-2b Pi caches Overpass replies cut short for
 *     a week); an all-empty overlay saves nothing at all — the Pi's own
 *     "never save all-empty" rule;
 *   - the index is written to index.json.tmp and renamed over index.json; a
 *     load falls back to the .tmp copy, and when neither can be read the
 *     tile files are swept rather than left orphaned for ever;
 *   - the old disk copies are deleted once the index holding their water is
 *     on disk (they would otherwise sit in Directory.Data, and in device
 *     backups, for good). A rollback to a pre-2b build re-creates them on its
 *     next online route.
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import {
    OVERLAY_CLASSES,
    emptyPackOverlay,
    overlayIsAllEmpty,
    splitOverlayIntoTiles,
    tileBounds,
    tileSignature,
    type Bbox,
    type PackOverlay,
} from './waterPackTiles';

const log = createLogger('WaterPackStore');

/** Where the pack lives. z20 = 20 tiles per degree; a later size is a new dir. */
export const WATER_PACK_DIR = 'water-pack/z20';
const INDEX_PATH = `${WATER_PACK_DIR}/index.json`;
/** The index is written here first, then renamed over INDEX_PATH. */
const INDEX_TMP_PATH = `${INDEX_PATH}.tmp`;
const TILE_DIR = `${WATER_PACK_DIR}/t`;
const tilePath = (key: string): string => `${TILE_DIR}/${key}.json`;
const TILE_FILE = /^(-?\d+_-?\d+)\.json$/;
const TILE_SCHEMA = 1;
/** The overlay recipe a tile was cut from: the Pi's v6 / the cloud's v6. */
const RECIPE = 'osm-v6';

export const WATER_PACK_LIMITS = {
    /** Total tile bytes before least-recently-used tiles are evicted… */
    maxBytes: 40_000_000,
    /** …down to this. */
    evictToBytes: 36_000_000,
    /** A tile bigger than this is not saved (measured densest: ~250 KB). */
    maxTileBytes: 2_000_000,
    maxWritesPerFill: 150,
    writesPerTick: 8,
    maxReadsPerCall: 400,
    maxEmptyEntries: 20_000,
};

/** Where a tile's data came from. */
export type WaterPackSource = 'pi' | 'cloud' | 'pi-legacy' | 'pi-stale' | 'legacy-disk';

export interface WaterPackEntry {
    /** When the data came from OSM (the Pi's fetch date, or the phone's). */
    fetchedAt: number;
    /** When it was written to this phone. */
    savedAt: number;
    lastUsedAt: number;
    source: WaterPackSource;
    verified: boolean;
    /** 0 = an empty tile, held in the index only. */
    bytes: number;
    counts: number[];
    sig: string;
}

export interface WaterPackFillOptions {
    source: WaterPackSource;
    /** Pi fresh/cache and cloud replies are; pre-2b Pi, Pi stale and old disk
     *  copies are not (they fill only tiles the pack lacks). */
    verified: boolean;
    fetchedAt: number;
    /** The route's ends: when a fill is capped, these tiles are written first. */
    focus?: { lat: number; lon: number }[];
}

/** The subset of @capacitor/filesystem the store uses. */
export interface WaterPackFs {
    writeFile(o: {
        path: string;
        data: string;
        directory: Directory;
        encoding: Encoding;
        recursive?: boolean;
    }): Promise<unknown>;
    readFile(o: { path: string; directory: Directory; encoding: Encoding }): Promise<{ data: string | Blob }>;
    deleteFile(o: { path: string; directory: Directory }): Promise<unknown>;
    /** Only for the one-time import of the pre-2b disk copies. */
    readdir?(o: { path: string; directory: Directory }): Promise<{
        files: { name: string; type?: string; mtime?: number }[];
    }>;
    stat?(o: { path: string; directory: Directory }): Promise<{ mtime?: number }>;
    /** For the index's write-then-rename; without it the index is written in
     *  place, as before. */
    rename?(o: { from: string; to: string; directory: Directory; toDirectory: Directory }): Promise<unknown>;
}

/** The pre-2b disk copies: osm-overlay/<W>_<S>_<E>_<N>.json, each edge
 *  rounded to 0.01° (OsmRouteOverlayService's old bboxKey). */
const LEGACY_DIR = 'osm-overlay';
const LEGACY_NAME = /^(-?\d+\.\d{2})_(-?\d+\.\d{2})_(-?\d+\.\d{2})_(-?\d+\.\d{2})\.json$/;
const LEGACY_MAX_FILES = 20;
const LEGACY_MAX_MS = 30_000;

export interface WaterPackStoreDeps {
    fs?: WaterPackFs;
    directory?: Directory;
    now?: () => number;
    /** Yield between write batches (a macrotask, so the bridge serves others). */
    tick?: () => Promise<void>;
    flushDelayMs?: number;
    limits?: Partial<typeof WATER_PACK_LIMITS>;
}

interface PreparedTile {
    key: string;
    /** The overlay's JSON — the snapshot taken when the fill was asked for,
     *  so a router that later decorates the same feature objects cannot leak
     *  into the saved copy. */
    overlayJson: string;
    sig: string;
    counts: number[];
    empty: boolean;
}

const SOURCES: readonly WaterPackSource[] = ['pi', 'cloud', 'pi-legacy', 'pi-stale', 'legacy-disk'];

/** The index on disk, compact: 20 000 empty tiles must not be megabytes. */
interface IndexFileEntry {
    f: number;
    s: number;
    u: number;
    o: WaterPackSource;
    v: 0 | 1;
    b?: number;
    c?: number[];
    g?: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function entryFromFile(e: unknown): WaterPackEntry | null {
    if (!e || typeof e !== 'object') return null;
    const r = e as Partial<IndexFileEntry>;
    if (!finite(r.f) || !finite(r.s) || !finite(r.u) || !SOURCES.includes(r.o as WaterPackSource)) return null;
    const bytes = finite(r.b) ? r.b : 0;
    if (bytes > 0 && (!Array.isArray(r.c) || typeof r.g !== 'string')) return null;
    return {
        fetchedAt: r.f,
        savedAt: r.s,
        lastUsedAt: r.u,
        source: r.o as WaterPackSource,
        verified: r.v === 1,
        bytes,
        counts: bytes > 0 ? (r.c as number[]) : [],
        sig: bytes > 0 ? (r.g as string) : '',
    };
}

function entryToFile(e: WaterPackEntry): IndexFileEntry {
    return {
        f: e.fetchedAt,
        s: e.savedAt,
        u: e.lastUsedAt,
        o: e.source,
        v: e.verified ? 1 : 0,
        ...(e.bytes > 0 ? { b: e.bytes, c: e.counts, g: e.sig } : {}),
    };
}

/** A tile file's overlay with every class present; null when it is not one. */
function overlayFromFile(text: string, key: string): PackOverlay | null {
    const parsed = JSON.parse(text) as { schema?: unknown; key?: unknown; overlay?: Record<string, unknown> };
    if (parsed?.schema !== TILE_SCHEMA || parsed.key !== key || !parsed.overlay || typeof parsed.overlay !== 'object')
        return null;
    const overlay = emptyPackOverlay();
    for (const k of OVERLAY_CLASSES) {
        const fc = parsed.overlay[k] as { features?: unknown } | undefined;
        if (fc === undefined) continue;
        if (!fc || !Array.isArray(fc.features)) return null;
        overlay[k] = fc as PackOverlay[typeof k];
    }
    return overlay;
}

export class WaterPackStore {
    private readonly fs: WaterPackFs;
    private readonly directory: Directory;
    private readonly now: () => number;
    private readonly tick: () => Promise<void>;
    private readonly flushDelayMs: number;
    private readonly limits: typeof WATER_PACK_LIMITS;
    private index: Map<string, WaterPackEntry> | null = null;
    private loading: Promise<Map<string, WaterPackEntry>> | null = null;
    /** Every write runs on this one chain, in order. */
    private chain: Promise<void> = Promise.resolve();
    /** Tiles being written right now: reads take them from here, never from a
     *  half-written file. */
    private readonly writing = new Map<string, string>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;
    /** The pre-2b disk copies have been imported (kept in the index file). */
    private legacyImported = false;
    /** The import in flight: a read waits for it, once, so the first offline
     *  route after the update still has the water it had before. */
    private importing: Promise<void> | null = null;

    constructor(deps: WaterPackStoreDeps = {}) {
        this.fs = deps.fs ?? (Filesystem as unknown as WaterPackFs);
        this.directory = deps.directory ?? Directory.Data;
        this.now = deps.now ?? (() => Date.now());
        this.tick = deps.tick ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        this.flushDelayMs = deps.flushDelayMs ?? 500;
        this.limits = { ...WATER_PACK_LIMITS, ...(deps.limits ?? {}) };
    }

    /** The index file at this path, parsed; null when absent or unreadable. */
    private async readIndexFile(
        path: string,
    ): Promise<{ index: Map<string, WaterPackEntry>; legacyImported: boolean } | null> {
        try {
            const res = await this.fs.readFile({ path, directory: this.directory, encoding: Encoding.UTF8 });
            const parsed = JSON.parse(typeof res.data === 'string' ? res.data : '') as {
                schema?: unknown;
                tiles?: Record<string, unknown>;
                legacyImported?: unknown;
            };
            if (parsed?.schema !== TILE_SCHEMA || !parsed.tiles || typeof parsed.tiles !== 'object') return null;
            const index = new Map<string, WaterPackEntry>();
            for (const [key, raw] of Object.entries(parsed.tiles)) {
                const entry = entryFromFile(raw);
                if (entry && /^-?\d+_-?\d+$/.test(key)) index.set(key, entry);
            }
            return { index, legacyImported: parsed.legacyImported === true };
        } catch {
            return null;
        }
    }

    private load(): Promise<Map<string, WaterPackEntry>> {
        if (this.index) return Promise.resolve(this.index);
        this.loading ??= (async () => {
            // The index, else its complete replacement left by a kill between
            // the write and the rename.
            const found = (await this.readIndexFile(INDEX_PATH)) ?? (await this.readIndexFile(INDEX_TMP_PATH));
            const index = found?.index ?? new Map<string, WaterPackEntry>();
            this.legacyImported = found?.legacyImported ?? false;
            this.index = index;
            // No index at all: any tile files are orphans no entry will ever
            // name (or delete). Swept first, before anything is written.
            if (!found) void this.enqueue(() => this.sweepOrphans(index));
            if (!this.legacyImported) {
                this.importing = this.enqueue(() => this.importLegacy(index));
                void this.enqueue(() => this.clearLegacyCopies());
            }
            return index;
        })();
        return this.loading;
    }

    /** Delete the tile files the index does not name. */
    private async sweepOrphans(index: Map<string, WaterPackEntry>): Promise<void> {
        if (!this.fs.readdir) return;
        let listed: { name: string; type?: string }[];
        try {
            listed = (await this.fs.readdir({ path: TILE_DIR, directory: this.directory })).files ?? [];
        } catch {
            return; // never had any
        }
        let removed = 0;
        for (const f of listed) {
            const m = f && f.type !== 'directory' ? TILE_FILE.exec(f.name) : null;
            if (!m || index.has(m[1]) || this.writing.has(m[1])) continue;
            await this.removeFile(m[1]);
            if (++removed % this.limits.writesPerTick === 0) await this.tick();
        }
        if (removed > 0) log.warn(`water pack: index unreadable — ${removed} orphan tile files swept`);
    }

    /** The one-time import of the pre-2b osm-overlay/ disk copies. */
    private async importLegacy(index: Map<string, WaterPackEntry>): Promise<void> {
        const started = Date.now();
        try {
            if (!this.fs.readdir) return;
            let listed: { name: string; type?: string; mtime?: number }[];
            try {
                listed = (await this.fs.readdir({ path: LEGACY_DIR, directory: this.directory })).files ?? [];
            } catch {
                return; // never had any
            }
            const copies = listed
                .filter((f) => f && f.type !== 'directory' && LEGACY_NAME.test(f.name))
                .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
                .slice(0, LEGACY_MAX_FILES);
            for (const f of copies) {
                if (Date.now() - started > LEGACY_MAX_MS) break;
                const m = LEGACY_NAME.exec(f.name)!;
                // The key was each edge rounded to 0.01°: the data is only
                // sure to cover the key shrunk by that much.
                const bbox: Bbox = [+m[1] + 0.01, +m[2] + 0.01, +m[3] - 0.01, +m[4] - 0.01];
                try {
                    let mtime = f.mtime;
                    if (!finite(mtime) && this.fs.stat)
                        mtime = (await this.fs.stat({ path: `${LEGACY_DIR}/${f.name}`, directory: this.directory }))
                            .mtime;
                    if (!finite(mtime) || mtime <= 0 || mtime > this.now()) continue; // undatable
                    const res = await this.fs.readFile({
                        path: `${LEGACY_DIR}/${f.name}`,
                        directory: this.directory,
                        encoding: Encoding.UTF8,
                    });
                    const parsed = JSON.parse(typeof res.data === 'string' ? res.data : '') as Record<string, unknown>;
                    const overlay = emptyPackOverlay();
                    let valid = !!parsed && typeof parsed === 'object';
                    for (const k of OVERLAY_CLASSES) {
                        const fc = parsed?.[k] as { features?: unknown } | undefined;
                        // A class the copy lacks is not "none here": copies
                        // from before berths (2026-07-03 to 07-05) would vouch
                        // that a marina has no pens (2026-10-02).
                        if (!fc || !Array.isArray(fc.features)) valid = false;
                        else overlay[k] = fc as PackOverlay[typeof k];
                    }
                    // An empty copy may be the old Pi's failure written over
                    // a good one: never imported.
                    if (!valid || overlayIsAllEmpty(overlay)) continue;
                    const tiles = splitOverlayIntoTiles(overlay, bbox);
                    const prepared = this.prepare(tiles);
                    if (prepared.length > 0)
                        await this.applyFill(
                            prepared,
                            {
                                source: 'legacy-disk',
                                verified: false,
                                fetchedAt: mtime,
                                allEmpty: false,
                            },
                            index,
                        );
                } catch (err) {
                    log.warn(
                        `old disk copy ${f.name} not imported: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
        } finally {
            this.legacyImported = true;
            this.scheduleFlush();
            this.importing = null;
        }
    }

    /**
     * Delete the old disk copies once the import has run (2026-10-02): the
     * index holding their water goes to disk first, so a kill in between
     * imports them again rather than losing water. Copies past the import's
     * cap or time limit go too — nothing would ever read them again.
     */
    private async clearLegacyCopies(): Promise<void> {
        if (!this.fs.readdir) return;
        let listed: { name: string; type?: string }[];
        try {
            listed = (await this.fs.readdir({ path: LEGACY_DIR, directory: this.directory })).files ?? [];
        } catch {
            return; // never had any
        }
        const copies = listed.filter((f) => f && f.type !== 'directory' && LEGACY_NAME.test(f.name));
        if (copies.length === 0) return;
        this.dirty = true;
        await this.writeIndex();
        let removed = 0;
        for (const f of copies) {
            await this.removePath(`${LEGACY_DIR}/${f.name}`);
            if (++removed % this.limits.writesPerTick === 0) await this.tick();
        }
    }

    private enqueue(job: () => Promise<void>): Promise<void> {
        const run = this.chain.then(job).catch((err) => {
            log.warn(`water pack write failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.chain = run;
        return run;
    }

    private scheduleFlush(): void {
        this.dirty = true;
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.enqueue(() => this.writeIndex());
        }, this.flushDelayMs);
    }

    /** Whole or not at all: written to INDEX_TMP_PATH, then renamed over the
     *  index, so a kill mid-write never loses the pack (2026-10-02). */
    private async writeIndex(): Promise<void> {
        if (!this.dirty || !this.index) return;
        this.dirty = false;
        const tiles: Record<string, IndexFileEntry> = {};
        for (const [key, e] of this.index) tiles[key] = entryToFile(e);
        const data = JSON.stringify({
            schema: TILE_SCHEMA,
            recipe: RECIPE,
            ...(this.legacyImported ? { legacyImported: true } : {}),
            tiles,
        });
        const write = (path: string) =>
            this.fs.writeFile({ path, data, directory: this.directory, encoding: Encoding.UTF8, recursive: true });
        if (!this.fs.rename) {
            await write(INDEX_PATH);
            return;
        }
        await write(INDEX_TMP_PATH);
        const rename = () =>
            this.fs.rename!({
                from: INDEX_TMP_PATH,
                to: INDEX_PATH,
                directory: this.directory,
                toDirectory: this.directory,
            });
        try {
            await rename();
        } catch {
            // A platform whose rename will not replace: the old index goes
            // first. A kill now leaves the .tmp copy, which load() reads.
            await this.removePath(INDEX_PATH);
            await rename();
        }
    }

    /** Every queued write done and the index on disk. */
    async whenIdle(): Promise<void> {
        await this.chain;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.enqueue(() => this.writeIndex());
    }

    /**
     * Save the tiles of a COMPLETE overlay of `fetchedBbox` (only the tiles
     * wholly inside it). The split and the JSON snapshot happen now; the
     * writes are queued. Never throws.
     */
    fillFromOverlay(overlay: Partial<PackOverlay>, fetchedBbox: Bbox, opts: WaterPackFillOptions): Promise<void> {
        let tiles: Map<string, PackOverlay>;
        try {
            tiles = splitOverlayIntoTiles(overlay, fetchedBbox);
        } catch (err) {
            log.warn(`water pack split failed: ${err instanceof Error ? err.message : String(err)}`);
            return Promise.resolve();
        }
        return this.fillTiles(tiles, { ...opts, allEmpty: overlayIsAllEmpty(overlay) });
    }

    /** Save prepared tiles under R1–R3. Never throws. */
    fillTiles(
        tiles: ReadonlyMap<string, PackOverlay>,
        opts: WaterPackFillOptions & { allEmpty: boolean },
    ): Promise<void> {
        // An all-empty answer saves nothing: an empty copy cannot be told from
        // a lost one (the Pi's own rule; 2026-10-02).
        if (opts.allEmpty) return Promise.resolve();
        const prepared = this.prepare(tiles);
        if (prepared.length === 0 || !finite(opts.fetchedAt)) return Promise.resolve();
        return this.enqueue(async () => this.applyFill(prepared, opts, await this.load()));
    }

    private prepare(tiles: ReadonlyMap<string, PackOverlay>): PreparedTile[] {
        const prepared: PreparedTile[] = [];
        for (const [key, tile] of tiles) {
            const overlayJson = JSON.stringify(tile);
            const counts = OVERLAY_CLASSES.map((k) => tile[k]?.features?.length ?? 0);
            prepared.push({
                key,
                overlayJson,
                sig: tileSignature(overlayJson),
                counts,
                empty: counts.every((c) => c === 0),
            });
        }
        return prepared;
    }

    private async applyFill(
        prepared: PreparedTile[],
        opts: WaterPackFillOptions & { allEmpty: boolean },
        index: Map<string, WaterPackEntry>,
    ): Promise<void> {
        const now = this.now();
        const thisFill = new Set(prepared.map((p) => p.key));
        const writes: PreparedTile[] = [];
        let changed = false;
        for (const p of prepared) {
            const cur = index.get(p.key);
            // An unverified answer may be cut short: its empty tiles are not
            // "nothing mapped here" (2026-10-02).
            if (!opts.verified && p.empty) continue;
            if (cur) {
                if (!opts.verified) continue; // R2
                if (opts.allEmpty && cur.bytes > 0) continue; // R1
                if (opts.fetchedAt < cur.fetchedAt) continue; // never back in time
                if ((p.empty && cur.bytes === 0) || (!p.empty && cur.sig === p.sig)) {
                    // R3, unchanged: the same water, confirmed again.
                    cur.fetchedAt = opts.fetchedAt;
                    cur.savedAt = now;
                    cur.source = opts.source;
                    cur.verified = true;
                    changed = true;
                    continue;
                }
            }
            if (p.empty) {
                // An empty tile is the index alone; a file it replaces goes.
                if (cur && cur.bytes > 0) await this.removeFile(p.key);
                index.set(p.key, {
                    fetchedAt: opts.fetchedAt,
                    savedAt: now,
                    lastUsedAt: cur?.lastUsedAt ?? now,
                    source: opts.source,
                    verified: opts.verified,
                    bytes: 0,
                    counts: [],
                    sig: '',
                });
                changed = true;
                continue;
            }
            writes.push(p);
        }

        // Nearest the route's ends first, when the fill is capped.
        const focus = opts.focus?.filter((f) => finite(f?.lat) && finite(f?.lon)) ?? [];
        if (focus.length > 0) {
            const distance = (key: string): number => {
                const [w, s, e, n] = tileBounds(key);
                const lon = (w + e) / 2;
                const lat = (s + n) / 2;
                return Math.min(...focus.map((f) => (f.lon - lon) ** 2 + (f.lat - lat) ** 2));
            };
            writes.sort((a, b) => distance(a.key) - distance(b.key));
        }

        let written = 0;
        for (const p of writes) {
            if (written >= this.limits.maxWritesPerFill) break;
            const data = `{"schema":${TILE_SCHEMA},"recipe":"${RECIPE}","key":"${p.key}","fetchedAt":${opts.fetchedAt},"savedAt":${now},"source":"${opts.source}","verified":${opts.verified},"overlay":${p.overlayJson}}`;
            if (data.length > this.limits.maxTileBytes) {
                log.warn(`water pack: tile ${p.key} is ${data.length} bytes — not saved`);
                continue;
            }
            const cur = index.get(p.key);
            this.writing.set(p.key, data);
            try {
                await this.fs.writeFile({
                    path: tilePath(p.key),
                    data,
                    directory: this.directory,
                    encoding: Encoding.UTF8,
                    recursive: true,
                });
                // The file first, then its index entry.
                index.set(p.key, {
                    fetchedAt: opts.fetchedAt,
                    savedAt: now,
                    lastUsedAt: cur?.lastUsedAt ?? now,
                    source: opts.source,
                    verified: opts.verified,
                    bytes: data.length,
                    counts: p.counts,
                    sig: p.sig,
                });
                changed = true;
            } catch (err) {
                log.warn(`water pack: tile ${p.key} not written: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                this.writing.delete(p.key);
            }
            written++;
            if (written % this.limits.writesPerTick === 0) await this.tick();
        }

        if (await this.evict(index, thisFill)) changed = true;
        if (changed) this.scheduleFlush();
    }

    private async removeFile(key: string): Promise<void> {
        await this.removePath(tilePath(key));
    }

    private async removePath(path: string): Promise<void> {
        try {
            await this.fs.deleteFile({ path, directory: this.directory });
        } catch {
            // Already gone.
        }
    }

    /** Least recently used first, never the current fill's tiles. */
    private async evict(index: Map<string, WaterPackEntry>, keep: ReadonlySet<string>): Promise<boolean> {
        let changed = false;
        let total = 0;
        let empties = 0;
        for (const e of index.values()) {
            total += e.bytes;
            if (e.bytes === 0) empties++;
        }
        const byAge = (filter: (e: WaterPackEntry) => boolean) =>
            [...index]
                .filter(([key, e]) => !keep.has(key) && filter(e))
                .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt || a.savedAt - b.savedAt);
        if (total > this.limits.maxBytes) {
            for (const [key, e] of byAge((x) => x.bytes > 0)) {
                if (total <= this.limits.evictToBytes) break;
                await this.removeFile(key);
                index.delete(key);
                total -= e.bytes;
                changed = true;
            }
            log.warn(`water pack: evicted to ${(total / 1e6).toFixed(1)} MB`);
        }
        if (empties > this.limits.maxEmptyEntries) {
            for (const [key] of byAge((x) => x.bytes === 0)) {
                if (empties <= this.limits.maxEmptyEntries) break;
                index.delete(key);
                empties--;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * The saved tiles among `keys` (empty ones included). A missing or corrupt
     * file counts as absent and leaves the index. At most maxReadsPerCall
     * files are read; any beyond count as absent.
     */
    async readTiles(
        keys: readonly string[],
    ): Promise<{ tiles: Map<string, PackOverlay>; entries: Map<string, WaterPackEntry> }> {
        const index = await this.load();
        if (this.importing) await this.importing;
        const now = this.now();
        const tiles = new Map<string, PackOverlay>();
        const entries = new Map<string, WaterPackEntry>();
        let reads = 0;
        let changed = false;
        for (const key of keys) {
            const entry = index.get(key);
            if (!entry) continue;
            let tile: PackOverlay | null = null;
            if (entry.bytes === 0) {
                tile = emptyPackOverlay();
            } else {
                if (reads >= this.limits.maxReadsPerCall) continue;
                reads++;
                try {
                    const writing = this.writing.get(key);
                    const text =
                        writing ??
                        (
                            await this.fs.readFile({
                                path: tilePath(key),
                                directory: this.directory,
                                encoding: Encoding.UTF8,
                            })
                        ).data;
                    tile = typeof text === 'string' ? overlayFromFile(text, key) : null;
                } catch {
                    tile = null;
                }
                if (!tile) {
                    // Only if nothing replaced it while the read was in flight.
                    if (index.get(key) === entry && !this.writing.has(key)) {
                        index.delete(key);
                        changed = true;
                    }
                    continue;
                }
            }
            tiles.set(key, tile);
            entries.set(key, { ...entry });
            if (now - entry.lastUsedAt >= 86_400_000) {
                entry.lastUsedAt = now;
                changed = true;
            }
        }
        if (changed) this.scheduleFlush();
        return { tiles, entries };
    }

    /** Copies of the index entries for these keys only. */
    async entriesFor(keys: readonly string[]): Promise<Map<string, WaterPackEntry>> {
        const index = await this.load();
        const out = new Map<string, WaterPackEntry>();
        for (const k of keys) {
            const e = index.get(k);
            if (e) out.set(k, { ...e });
        }
        return out;
    }
}

let shared: WaterPackStore | null = null;

/** The phone's one pack. */
export function getWaterPackStore(): WaterPackStore {
    shared ??= new WaterPackStore();
    return shared;
}

export function __resetWaterPackStoreForTests(store: WaterPackStore | null = null): void {
    shared = store;
}
