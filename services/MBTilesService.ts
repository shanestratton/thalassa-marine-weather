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
import { Filesystem, Directory } from '@capacitor/filesystem';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

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
    /** Estimated memory usage in MB */
    memoryMB: number;
}

type Listener = () => void;

// ── Transparent 1x1 PNG (reserved for missing tile fallback) ──
const _EMPTY_TILE = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// ── Service ──

class MBTilesServiceImpl {
    private sql: SqlJsStatic | null = null;
    private sqlLoading: Promise<SqlJsStatic> | null = null;
    private databases = new Map<string, Database>();
    private chartInfo = new Map<string, OpenChart>();
    private listeners = new Set<Listener>();

    // Blob URL pool — revoke old ones to prevent memory leaks
    private blobUrls: string[] = [];
    private readonly MAX_BLOB_URLS = 1000;

    // Tile data cache — LRU cache of recently accessed tiles to avoid
    // repeated SQLite queries for the same tile during panning/zooming
    private tileCache = new Map<string, Uint8Array | null>();
    private readonly MAX_TILE_CACHE = 500;

    // ── Initialisation ──

    /** Load the sql.js WASM binary (once, cached). */
    private async ensureSql(): Promise<SqlJsStatic> {
        if (this.sql) return this.sql;
        if (this.sqlLoading) return this.sqlLoading;

        this.sqlLoading = initSqlJs({
            // Bundled in public/ — works offline (no CDN needed at sea)
            locateFile: () => '/sql-wasm.wasm',
        });

        this.sql = await this.sqlLoading;
        this.sqlLoading = null;
        log.info('sql.js WASM loaded');
        return this.sql;
    }

    // ── Open / Close ──

    /**
     * Open an MBTiles file from chart_downloads/ and load it into memory.
     * Returns the chart metadata on success.
     */
    async open(fileName: string): Promise<OpenChart> {
        // Already open?
        const existing = this.chartInfo.get(fileName);
        if (existing) return existing;

        const SQL = await this.ensureSql();

        log.info(`Opening ${fileName}...`);

        // Read file as binary via fetch (avoids base64 overhead of Filesystem.readFile)
        const uri = await Filesystem.getUri({
            path: `chart_downloads/${fileName}`,
            directory: Directory.Cache,
        });

        const response = await fetch(uri.uri);
        if (!response.ok) {
            throw new Error(`Failed to read ${fileName}: HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const memoryMB = Math.round(bytes.length / 1024 / 1024);

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
        };

        this.chartInfo.set(fileName, chart);
        log.info(
            `Opened: ${chart.name} (${metadata.format}, zoom ${metadata.minzoom}-${metadata.maxzoom}, ${memoryMB} MB)`,
        );
        this.notify();

        return chart;
    }

    /** Close a chart and free memory. */
    close(fileName: string): void {
        const db = this.databases.get(fileName);
        if (db) {
            db.close();
            this.databases.delete(fileName);
            this.chartInfo.delete(fileName);
            // Evict tile cache entries for this chart
            for (const key of this.tileCache.keys()) {
                if (key.startsWith(`${fileName}/`)) this.tileCache.delete(key);
            }
            log.info(`Closed: ${fileName}`);
            this.notify();
        }
    }

    /** Close all open charts. */
    closeAll(): void {
        for (const [name, db] of this.databases) {
            db.close();
            log.info(`Closed: ${name}`);
        }
        this.databases.clear();
        this.chartInfo.clear();
        this.tileCache.clear();
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
                'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
            );
            stmt.bind([z, x, tmsY]);

            let result: Uint8Array | null = null;
            if (stmt.step()) {
                const row = stmt.get();
                result = row[0] as Uint8Array;
            }
            stmt.free();

            // Cache the result (including null for missing tiles — avoids repeated lookups)
            this.tileCache.set(cacheKey, result);
            if (this.tileCache.size > this.MAX_TILE_CACHE) {
                // Evict oldest entry (Map preserves insertion order)
                const firstKey = this.tileCache.keys().next().value;
                if (firstKey) this.tileCache.delete(firstKey);
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
        const mimeType =
            metadata?.format === 'jpg' || metadata?.format === 'jpeg'
                ? 'image/jpeg'
                : metadata?.format === 'webp'
                  ? 'image/webp'
                  : metadata?.format === 'pbf'
                    ? 'application/x-protobuf'
                    : 'image/png';

        const blob = new Blob([tileData.buffer as ArrayBuffer], { type: mimeType });
        const url = URL.createObjectURL(blob);

        // Pool management — revoke oldest URLs to prevent memory leaks
        this.blobUrls.push(url);
        while (this.blobUrls.length > this.MAX_BLOB_URLS) {
            const old = this.blobUrls.shift();
            if (old) URL.revokeObjectURL(old);
        }

        return url;
    }

    // ── Queries ──

    isOpen(fileName: string): boolean {
        return this.databases.has(fileName);
    }

    getOpenCharts(): OpenChart[] {
        return [...this.chartInfo.values()];
    }

    /** Subscribe to changes (chart opened/closed). */
    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // ── Internal ──

    private readMetadata(db: Database): MBTilesMetadata {
        const meta: Record<string, string> = {};
        try {
            const stmt = db.prepare('SELECT name, value FROM metadata');
            while (stmt.step()) {
                const row = stmt.getAsObject();
                meta[row.name as string] = row.value as string;
            }
            stmt.free();
        } catch {
            log.warn('Could not read metadata table');
        }

        // Parse bounds: "west,south,east,north"
        let bounds: [number, number, number, number] | undefined;
        if (meta.bounds) {
            const parts = meta.bounds.split(',').map(Number);
            if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                bounds = parts as [number, number, number, number];
            }
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
        this.listeners.forEach((fn) => fn());
    }
}

export const MBTilesService = new MBTilesServiceImpl();
