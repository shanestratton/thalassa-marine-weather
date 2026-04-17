/**
 * Cache — SQLite-backed key-value cache with TTL support.
 *
 * Stores API responses and tile data with automatic expiration.
 * Uses better-sqlite3 for synchronous, zero-config persistence.
 *
 * Two tables:
 *   - `kv_cache`: JSON API responses (weather, tides, buoys, etc.)
 *   - `tile_cache`: Binary tile data (satellite, chart tiles, GRIB)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface CacheEntry<T = unknown> {
    data: T;
    cachedAt: number;
    expiresAt: number;
    source: string;
}

export class Cache {
    private db: Database.Database;

    constructor(cacheDir: string) {
        fs.mkdirSync(cacheDir, { recursive: true });
        const dbPath = path.join(cacheDir, 'thalassa-cache.db');

        this.db = new Database(dbPath);
        // ── Performance pragmas (tuned for Pi SD-card I/O) ──
        // WAL: readers and writers work concurrently; readers never block writers.
        this.db.pragma('journal_mode = WAL');
        // NORMAL: skip fsync on every write; still durable across checkpoints.
        this.db.pragma('synchronous = NORMAL');
        // 64MB page cache (default is 2MB) — big win for hot-key reads.
        this.db.pragma('cache_size = -64000');
        // Keep temp B-trees in RAM instead of spilling to SD card.
        this.db.pragma('temp_store = MEMORY');
        // 256MB memory-mapped reads — tile reads become near-RAM speed.
        this.db.pragma('mmap_size = 268435456');
        // Checkpoint every ~4MB of WAL instead of the 1000-page default —
        // keeps the WAL file small so readers don't traverse a huge log.
        this.db.pragma('wal_autocheckpoint = 1000');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kv_cache (
                key TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                cached_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                source TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS tile_cache (
                key TEXT PRIMARY KEY,
                data BLOB NOT NULL,
                content_type TEXT NOT NULL,
                cached_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_cache(expires_at);
            CREATE INDEX IF NOT EXISTS idx_tile_expires ON tile_cache(expires_at);
        `);

        // Clean up expired entries on startup
        this.purgeExpired();
    }

    // ── Key-Value Cache (JSON responses) ──

    get<T = unknown>(key: string): CacheEntry<T> | null {
        const row = this.db
            .prepare('SELECT data, cached_at, expires_at, source FROM kv_cache WHERE key = ?')
            .get(key) as { data: string; cached_at: number; expires_at: number; source: string } | undefined;

        if (!row) return null;
        if (row.expires_at < Date.now()) {
            // Expired — still return it (stale) but caller should refresh
            // This allows serving stale data when offline
        }

        return {
            data: JSON.parse(row.data) as T,
            cachedAt: row.cached_at,
            expiresAt: row.expires_at,
            source: row.source,
        };
    }

    set<T = unknown>(key: string, data: T, ttlMs: number, source = ''): void {
        const now = Date.now();
        this.db
            .prepare(
                'INSERT OR REPLACE INTO kv_cache (key, data, cached_at, expires_at, source) VALUES (?, ?, ?, ?, ?)',
            )
            .run(key, JSON.stringify(data), now, now + ttlMs, source);
    }

    /** Check if a fresh (non-expired) entry exists. */
    hasFresh(key: string): boolean {
        const row = this.db.prepare('SELECT expires_at FROM kv_cache WHERE key = ?').get(key) as
            | { expires_at: number }
            | undefined;
        return !!row && row.expires_at > Date.now();
    }

    // ── Tile Cache (binary data) ──

    getTile(key: string): { data: Buffer; contentType: string } | null {
        const row = this.db.prepare('SELECT data, content_type, expires_at FROM tile_cache WHERE key = ?').get(key) as
            | { data: Buffer; content_type: string; expires_at: number }
            | undefined;

        if (!row) return null;
        // Return even if expired (stale tiles better than no tiles offshore)
        return { data: row.data, contentType: row.content_type };
    }

    setTile(key: string, data: Buffer, contentType: string, ttlMs: number): void {
        const now = Date.now();
        this.db
            .prepare(
                'INSERT OR REPLACE INTO tile_cache (key, data, content_type, cached_at, expires_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(key, data, contentType, now, now + ttlMs);
    }

    hasFreshTile(key: string): boolean {
        const row = this.db.prepare('SELECT expires_at FROM tile_cache WHERE key = ?').get(key) as
            | { expires_at: number }
            | undefined;
        return !!row && row.expires_at > Date.now();
    }

    // ── Maintenance ──

    purgeExpired(): { kvDeleted: number; tileDeleted: number } {
        const now = Date.now();
        const kv = this.db.prepare('DELETE FROM kv_cache WHERE expires_at < ?').run(now);
        const tiles = this.db.prepare('DELETE FROM tile_cache WHERE expires_at < ?').run(now);
        return { kvDeleted: kv.changes, tileDeleted: tiles.changes };
    }

    getStats(): {
        kvEntries: number;
        tileEntries: number;
        kvFresh: number;
        tileFresh: number;
        dbSizeMB: number;
    } {
        const now = Date.now();
        const kv = this.db.prepare('SELECT COUNT(*) as c FROM kv_cache').get() as { c: number };
        const tile = this.db.prepare('SELECT COUNT(*) as c FROM tile_cache').get() as { c: number };
        const kvFresh = this.db.prepare('SELECT COUNT(*) as c FROM kv_cache WHERE expires_at > ?').get(now) as {
            c: number;
        };
        const tileFresh = this.db.prepare('SELECT COUNT(*) as c FROM tile_cache WHERE expires_at > ?').get(now) as {
            c: number;
        };

        // Get DB file size
        const dbPath = this.db.name;
        let dbSizeMB = 0;
        try {
            const stat = fs.statSync(dbPath);
            dbSizeMB = Math.round((stat.size / 1024 / 1024) * 10) / 10;
        } catch {
            /* ignore */
        }

        return {
            kvEntries: kv.c,
            tileEntries: tile.c,
            kvFresh: kvFresh.c,
            tileFresh: tileFresh.c,
            dbSizeMB,
        };
    }

    close(): void {
        this.db.close();
    }
}
