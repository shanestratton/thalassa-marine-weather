/**
 * MBTilesService — Local chart tile reader using sql.js (SQLite in WASM).
 *
 * Opens MBTiles files from Capacitor's filesystem, loads them into an
 * in-memory SQLite database, and serves individual tiles synchronously.
 *
 * Designed to work with Mapbox GL's `transformRequest` — since sql.js
 * queries are synchronous, we can intercept tile URLs in transformRequest
 * and return blob URLs with zero async overhead.
 *
 * MBTiles spec: https://github.com/mapbox/mbtiles-spec
 */

import { createLogger } from '../utils/createLogger';
import { looksGzipped, sniffImageMime } from '../utils/imageBytes';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import type { Database, SqlJsStatic } from 'sql.js';
import { waitForLocalChart } from './charts/localChartWait';
import {
    assertLocalChartName,
    assertLocalChartSize,
    assertLocalChartSqliteBytes,
    readLocalChartBytes,
    localChartRasterDimensions,
    LOCAL_CHART_OPEN_BYTES,
    LOCAL_CHART_TILE_BYTES,
    LOCAL_CHART_CACHE_BYTES,
} from './charts/localChartLimits';

const log = createLogger('MBTiles');

// ── Types ──

export interface MBTilesMetadata {
    name: string;
    format: 'png' | 'jpg' | 'pbf' | 'webp' | string;
    bounds?: [number, number, number, number]; // [west, south, east, north]
    center?: [number, number, number]; // [lon, lat, zoom]
    minzoom?: number;
    maxzoom?: number;
    description?: string;
    attribution?: string;
    type?: 'overlay' | 'baselayer';
}

export interface OpenChart {
    name: string;
    fileName: string;
    metadata: MBTilesMetadata;
    /** Encoded file MiB; SQLite and decoder working memory are additional. */
    memoryMB: number;
    fileBytes: number;
    storage?: 'retained';
}

type Listener = () => void;

/**
 * A transparent 1×1 PNG, the tile useMapInit hands Mapbox for a square a chart
 * does not hold. The data URL it used before was malformed (153 base64
 * characters, a bad IDAT CRC): Chromium ("Failed to fetch") and WebKit ("Load
 * failed") both refused it, so every hole in a chart raised a map error
 * (measured 2026-10-08, browser-tests/mbtiles-csp.spec.ts).
 */
export const TRANSPARENT_TILE_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

// ── Service ──

class MBTilesServiceImpl {
    private sql: SqlJsStatic | null = null;
    private sqlLoading: Promise<SqlJsStatic> | null = null;
    private databases = new Map<string, Database>();
    private chartInfo = new Map<string, OpenChart>();
    /** Most recently used last. */
    private useOrder: string[] = [];
    private openQueue: Promise<unknown> = Promise.resolve();
    private readonly openEpoch = new Map<string, number>();
    private allEpoch = 0;
    private readonly sourceCurrent = new Map<string, () => boolean>();

    /** Total megabytes currently held across every open chart. */
    getMemoryMB(): number {
        let total = 0;
        for (const c of this.chartInfo.values()) total += c.memoryMB;
        return total;
    }

    /**
     * Close least-recently-used charts until `incomingMB` fits under the cap.
     *
     * The file-size gate applies before any read. Accounting uses exact bytes,
     * including charts smaller than one rounded megabyte.
     */
    private evictUntilRoomFor(incomingBytes: number, keep: string): void {
        const held = () => [...this.chartInfo.values()].reduce((total, chart) => total + chart.fileBytes, 0);
        while (held() + incomingBytes > LOCAL_CHART_OPEN_BYTES) {
            const victim = this.useOrder.find((f) => f !== keep && this.chartInfo.has(f));
            if (!victim) throw new Error('Close another local chart before opening this one.');
            this.close(victim);
        }
    }

    private touch(fileName: string): void {
        this.useOrder = this.useOrder.filter((f) => f !== fileName);
        this.useOrder.push(fileName);
    }
    private listeners = new Set<Listener>();

    // Blob URL pool — revoke old ones to prevent memory leaks
    private blobUrls: Array<{ chart: string; url: string; bytes: number }> = [];
    private readonly MAX_BLOB_URLS = 128;

    // Tile data cache — LRU cache of recently accessed tiles to avoid
    // repeated SQLite queries for the same tile during panning/zooming
    private tileCache = new Map<string, Uint8Array | null>();
    private readonly MAX_TILE_CACHE = 500;
    private tileCacheBytes = 0;

    // ── Initialisation ──

    /** Load the sql.js WASM binary (once, cached). */
    private async ensureSql(): Promise<SqlJsStatic> {
        if (this.sql) return this.sql;
        if (this.sqlLoading) return this.sqlLoading;

        this.sqlLoading = import('sql.js').then(({ default: initSqlJs }) =>
            initSqlJs({ locateFile: () => '/sql-wasm.wasm' }),
        );
        try {
            this.sql = await this.sqlLoading;
            return this.sql;
        } finally {
            this.sqlLoading = null;
        }
    }

    // ── Open / Close ──

    /**
     * Open an MBTiles file from chart_downloads/ and load it into memory.
     * Returns the chart metadata on success.
     */
    open(fileName: string): Promise<OpenChart> {
        assertLocalChartName(fileName);
        const epoch = this.openEpoch.get(fileName) ?? 0,
            allEpoch = this.allEpoch;
        const current = () => epoch === (this.openEpoch.get(fileName) ?? 0) && allEpoch === this.allEpoch;
        const task = this.openQueue.then(() => this.openOne(fileName, current));
        this.openQueue = task.catch(() => undefined);
        return task;
    }

    /** The retained adapter supplies checksum-admitted bytes, never a Cache path. */
    openRetained(source: {
        fileName: string;
        name: string;
        bytes: Uint8Array;
        isCurrent(): boolean;
    }): Promise<OpenChart> {
        assertLocalChartName(source.fileName);
        if (!/^retained-[a-f0-9]{32}-[a-f0-9-]{36}\.mbtiles$/.test(source.fileName))
            throw new Error('Invalid retained chart identity.');
        assertLocalChartSqliteBytes(source.bytes);
        const epoch = this.openEpoch.get(source.fileName) ?? 0,
            allEpoch = this.allEpoch;
        const check = () => {
            if (
                epoch !== (this.openEpoch.get(source.fileName) ?? 0) ||
                allEpoch !== this.allEpoch ||
                !source.isCurrent()
            )
                throw new Error('Chart opening was cancelled.');
        };
        const task = this.openQueue.then(async () => {
            check();
            const existing = this.chartInfo.get(source.fileName);
            if (existing) {
                if (existing.storage !== 'retained')
                    throw new Error('The existing chart has a different owner or source.');
                if (this.sourceCurrent.get(source.fileName) === source.isCurrent) return existing;
                this.close(source.fileName);
                throw new Error('The previous local chart reader was retired. Choose Display again.');
            }
            this.evictUntilRoomFor(source.bytes.byteLength, source.fileName);
            const SQL = await waitForLocalChart(this.ensureSql(), check, performance.now() + 15_000);
            check();
            const db = new SQL.Database(source.bytes);
            try {
                this.assertRetainedTables(db);
                const metadata = this.readMetadata(db, true);
                if (!['png', 'jpg', 'jpeg', 'webp'].includes(metadata.format))
                    throw new Error('Choose a raster MBTiles chart; vector MBTiles are not supported here.');
                if (
                    (metadata.minzoom !== undefined &&
                        (!Number.isInteger(metadata.minzoom) || metadata.minzoom < 0 || metadata.minzoom > 22)) ||
                    (metadata.maxzoom !== undefined &&
                        (!Number.isInteger(metadata.maxzoom) || metadata.maxzoom < 0 || metadata.maxzoom > 22)) ||
                    (metadata.minzoom ?? 0) > (metadata.maxzoom ?? 22) ||
                    (metadata.bounds &&
                        (!metadata.bounds.every(Number.isFinite) ||
                            metadata.bounds[0] < -180 ||
                            metadata.bounds[2] > 180 ||
                            metadata.bounds[0] >= metadata.bounds[2] ||
                            metadata.bounds[1] < -85.05112878 ||
                            metadata.bounds[3] > 85.05112878 ||
                            metadata.bounds[1] >= metadata.bounds[3]))
                )
                    throw new Error('This MBTiles chart has unsupported bounds or zoom levels.');
                check();
                const chart: OpenChart = {
                    name: source.name,
                    fileName: source.fileName,
                    metadata,
                    memoryMB: source.bytes.byteLength / 1024 / 1024,
                    fileBytes: source.bytes.byteLength,
                    storage: 'retained',
                };
                this.databases.set(source.fileName, db);
                this.chartInfo.set(source.fileName, chart);
                this.sourceCurrent.set(source.fileName, source.isCurrent);
                this.touch(source.fileName);
                this.notify();
                return chart;
            } catch (error) {
                db.close();
                throw error;
            }
        });
        this.openQueue = task.catch(() => undefined);
        return task;
    }

    closeRetained(fileName: string, proof: () => boolean): void {
        if (this.sourceCurrent.get(fileName) === proof) this.close(fileName);
    }

    private async openOne(fileName: string, current: () => boolean): Promise<OpenChart> {
        if (!current()) throw new Error('Chart opening was cancelled.');
        // Already open?
        const existing = this.chartInfo.get(fileName);
        if (existing) {
            this.touch(fileName);
            return existing;
        }

        log.info(`Opening ${fileName}...`);

        const stat = await Filesystem.stat({ path: `chart_downloads/${fileName}`, directory: Directory.Cache });
        assertLocalChartSize(stat.size);
        if (stat.type !== 'file' || !current()) throw new Error('Choose a local chart file.');
        this.evictUntilRoomFor(stat.size, fileName);

        // Read file as binary via fetch (avoids base64 overhead of Filesystem.readFile)
        const uri = await Filesystem.getUri({
            path: `chart_downloads/${fileName}`,
            directory: Directory.Cache,
        });

        // On iOS getUri answers file:///…, and the app's CSP refuses a file:
        // fetch ("Refused to connect to file:///… because it does not appear
        // in the connect-src directive", WebKit, 2026-10-08): CapacitorHttp
        // leaves non-HTTP URLs to the WebView's own fetch. convertFileSrc
        // serves the same file from the app's own origin, which connect-src
        // 'self' allows; on the web it returns the path unchanged.
        const response = await fetch(Capacitor.convertFileSrc(uri.uri), { signal: AbortSignal.timeout(30000) });
        const bytes = await readLocalChartBytes(response, stat.size);
        if (!current()) throw new Error('Chart opening was cancelled.');
        const SQL = await this.ensureSql();
        if (!current()) throw new Error('Chart opening was cancelled.');
        const memoryMB = bytes.length / 1024 / 1024;

        log.info(`Loaded ${memoryMB} MB into memory, creating database...`);

        const db = new SQL.Database(bytes);
        this.databases.set(fileName, db);

        // Read metadata
        const metadata = this.readMetadata(db);
        const chart: OpenChart = {
            name: metadata.name || fileName.replace(/\.[^.]+$/, ''),
            fileName,
            metadata,
            memoryMB,
            fileBytes: bytes.byteLength,
        };

        this.chartInfo.set(fileName, chart);
        this.touch(fileName);
        log.info(
            `Opened: ${chart.name} (${metadata.format}, zoom ${metadata.minzoom}-${metadata.maxzoom}, ${memoryMB} MB)`,
        );
        this.notify();

        return chart;
    }

    /** Close a chart and free memory. */
    close(fileName: string): void {
        this.openEpoch.set(fileName, (this.openEpoch.get(fileName) ?? 0) + 1);
        this.sourceCurrent.delete(fileName);
        const db = this.databases.get(fileName);
        if (db) {
            db.close();
            this.databases.delete(fileName);
            this.chartInfo.delete(fileName);
            this.useOrder = this.useOrder.filter((f) => f !== fileName);
            // Evict tile cache entries for this chart
            for (const key of this.tileCache.keys()) {
                if (key.startsWith(`${fileName}/`)) {
                    this.tileCacheBytes -= this.tileCache.get(key)?.byteLength ?? 0;
                    this.tileCache.delete(key);
                }
            }
            this.retireBlobUrls(fileName);
            log.info(`Closed: ${fileName}`);
            this.notify();
        }
    }

    /** Close all open charts. */
    closeAll(): void {
        this.allEpoch++;
        this.openEpoch.clear();
        for (const [name, db] of this.databases) {
            db.close();
            log.info(`Closed: ${name}`);
        }
        this.databases.clear();
        this.chartInfo.clear();
        this.sourceCurrent.clear();
        this.useOrder = [];
        this.tileCache.clear();
        this.tileCacheBytes = 0;
        this.retireBlobUrls();
        this.notify();
    }

    // ── Tile Access (synchronous!) ──

    /**
     * Get a single tile from an open MBTiles database.
     * Returns the raw tile data (PNG/JPG/PBF) or null if not found.
     *
     * This is **synchronous** — sql.js queries execute in WASM memory
     * with zero async overhead, making it ideal for use inside
     * Mapbox GL's `transformRequest`.
     */
    getTile(fileName: string, z: number, x: number, y: number): Uint8Array | null {
        const source = this.sourceCurrent.get(fileName);
        if (source) {
            try {
                if (!source()) {
                    this.close(fileName);
                    return null;
                }
            } catch {
                this.close(fileName);
                return null;
            }
        }
        if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z)
            return null;
        const db = this.databases.get(fileName);
        if (!db) return null;

        // LRU tile cache — avoids re-querying SQLite for tiles Mapbox re-requests
        // during pan/zoom animations (same tile gets requested multiple times)
        const cacheKey = `${fileName}/${z}/${x}/${y}`;
        if (this.tileCache.has(cacheKey)) {
            return this.tileCache.get(cacheKey)!;
        }

        // MBTiles uses TMS tiling scheme — y-axis is flipped vs XYZ (Slippy Map)
        const tmsY = (1 << z) - 1 - y;

        try {
            const stmt = db.prepare(
                'SELECT substr(tile_data, 1, ?) FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1',
            );
            stmt.bind([LOCAL_CHART_TILE_BYTES + 1, z, x, tmsY]);

            let result: Uint8Array | null = null;
            if (stmt.step()) {
                const row = stmt.get();
                const value = row[0];
                if (value instanceof Uint8Array && value.byteLength <= LOCAL_CHART_TILE_BYTES) result = value;
            }
            stmt.free();

            // Cache the result (including null for missing tiles — avoids repeated lookups)
            this.tileCache.set(cacheKey, result);
            this.tileCacheBytes += result?.byteLength ?? 0;
            while (this.tileCache.size > this.MAX_TILE_CACHE || this.tileCacheBytes > LOCAL_CHART_CACHE_BYTES) {
                // Evict oldest entry (Map preserves insertion order)
                const firstKey = this.tileCache.keys().next().value;
                if (!firstKey) break;
                this.tileCacheBytes -= this.tileCache.get(firstKey)?.byteLength ?? 0;
                this.tileCache.delete(firstKey);
            }

            return result;
        } catch {
            return null;
        }
    }

    /**
     * Get a tile as a blob URL for use in Mapbox GL's transformRequest.
     * Creates the blob URL synchronously. Old URLs are auto-revoked to
     * prevent memory leaks.
     */
    getTileBlobUrl(fileName: string, z: number, x: number, y: number): string | null {
        const tileData = this.getTile(fileName, z, x, y);
        if (!tileData) return null;

        const metadata = this.chartInfo.get(fileName)?.metadata;
        // Prefer the SNIFFED type over chart metadata: a corrupt/foreign row
        // in a user-imported .mbtiles labelled webp went straight into the GL
        // image decoder (decoder faults on beta WebKit are renderer kills).
        // Unrecognised raster bytes return null so useMapInit's transparent
        // fallback tile is used instead of a decode attempt.
        const declaredPbf = metadata?.format === 'pbf';
        const retained = this.chartInfo.get(fileName)?.storage === 'retained';
        const sniffed = sniffImageMime(tileData);
        if (sniffed && !localChartRasterDimensions(tileData, sniffed)) return null;
        const mimeType =
            sniffed ?? (!retained && (declaredPbf || looksGzipped(tileData)) ? 'application/x-protobuf' : null);
        if (!mimeType) return null;

        const blob = new Blob([new Uint8Array(tileData)], { type: mimeType });
        const url = URL.createObjectURL(blob);

        // Pool management — revoke oldest URLs to prevent memory leaks
        this.blobUrls.push({ chart: fileName, url, bytes: tileData.byteLength });
        while (
            this.blobUrls.length > this.MAX_BLOB_URLS ||
            this.blobUrls.reduce((sum, entry) => sum + entry.bytes, 0) > LOCAL_CHART_CACHE_BYTES
        ) {
            const old = this.blobUrls.shift();
            if (old) URL.revokeObjectURL(old.url);
        }

        return url;
    }

    private retireBlobUrls(chart?: string): void {
        this.blobUrls = this.blobUrls.filter((entry) => {
            if (chart !== undefined && entry.chart !== chart) return true;
            URL.revokeObjectURL(entry.url);
            return false;
        });
    }

    // ── Queries ──

    isOpen(fileName: string): boolean {
        return this.databases.has(fileName);
    }

    getOpenCharts(): OpenChart[] {
        return [...this.chartInfo.values()].filter((chart) => {
            try {
                return this.sourceCurrent.get(chart.fileName)?.() ?? true;
            } catch {
                return false;
            }
        });
    }

    /** Subscribe to changes (chart opened/closed). */
    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // ── Internal ──

    private assertRetainedTables(db: Database): void {
        // Ordinary on-disk tables only: a view/virtual table or generated
        // expression must not turn a bounded chart read into arbitrary SQL work.
        db.run('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
        for (const [table, fields] of [
            ['metadata', ['name', 'value']],
            ['tiles', ['zoom_level', 'tile_column', 'tile_row', 'tile_data']],
        ] as const) {
            let statement = db.prepare('SELECT type, rootpage FROM sqlite_master WHERE name = ? LIMIT 2');
            try {
                statement.bind([table]);
                if (!statement.step()) throw new Error('The MBTiles chart is missing an ordinary data table.');
                const row = statement.getAsObject();
                if (row.type !== 'table' || typeof row.rootpage !== 'number' || row.rootpage < 1 || statement.step())
                    throw new Error('MBTiles views and virtual tables are not supported.');
            } finally {
                statement.free();
            }
            statement = db.prepare(`PRAGMA table_xinfo('${table}')`);
            try {
                const names = new Set<string>();
                let count = 0;
                while (statement.step()) {
                    const row = statement.getAsObject();
                    if (++count > 16 || typeof row.name !== 'string' || row.hidden !== 0)
                        throw new Error('The MBTiles table has unsupported generated or hidden columns.');
                    names.add(row.name);
                }
                if (!fields.every((field) => names.has(field)))
                    throw new Error('The MBTiles table is missing required columns.');
            } finally {
                statement.free();
            }
        }
    }

    private readMetadata(db: Database, strict = false): MBTilesMetadata {
        const meta: Record<string, string> = {};
        let stmt: ReturnType<Database['prepare']> | undefined;
        try {
            stmt = db.prepare(
                'SELECT substr(name, 1, 65) AS name, substr(value, 1, 2049) AS value FROM metadata LIMIT 257',
            );
            let count = 0;
            while (stmt.step()) {
                if (++count > 256) throw new Error('Too much chart metadata.');
                const row = stmt.getAsObject();
                if (
                    typeof row.name !== 'string' ||
                    row.name.length > 64 ||
                    typeof row.value !== 'string' ||
                    row.value.length > 2048
                )
                    throw new Error('Chart metadata is too large.');
                meta[row.name] = row.value;
            }
        } catch (error) {
            if (strict) throw error;
            log.warn('Could not read metadata table');
        } finally {
            stmt?.free();
        }
        if (strict && !meta.format) throw new Error('The MBTiles chart has no raster format metadata.');

        // Parse bounds: "west,south,east,north"
        let bounds: [number, number, number, number] | undefined;
        if (meta.bounds) {
            const parts = meta.bounds.split(',').map(Number);
            if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                bounds = parts as [number, number, number, number];
            } else if (strict) throw new Error('The chart has invalid bounds.');
        }

        // Parse center: "lon,lat,zoom"
        let center: [number, number, number] | undefined;
        if (meta.center) {
            const parts = meta.center.split(',').map(Number);
            if (parts.length >= 2 && parts.every((n) => !isNaN(n))) {
                center = [parts[0], parts[1], parts[2] || 8] as [number, number, number];
            }
        }

        return {
            name: meta.name || '',
            format: (meta.format || 'png') as MBTilesMetadata['format'],
            bounds,
            center,
            minzoom: meta.minzoom ? Number(meta.minzoom) : undefined,
            maxzoom: meta.maxzoom ? Number(meta.maxzoom) : undefined,
            description: meta.description,
            attribution: meta.attribution,
            type: (meta.type as 'overlay' | 'baselayer') || 'overlay',
        };
    }

    private notify(): void {
        for (const fn of [...this.listeners]) {
            try {
                fn();
            } catch {
                /* One view cannot interrupt database retirement or another view's owner fence. */
            }
        }
    }
}

export const MBTilesService = new MBTilesServiceImpl();
