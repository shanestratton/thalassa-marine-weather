/**
 * Seabed mapping: where the Pi keeps soundings until they are uploaded.
 *
 * CACHE_DIR/seabed/seabed.db, SQLite in WAL mode, apart from the track's
 * database so neither can starve the other. Four tables:
 *   seabed_settings   the switch, consent, zones, note, draft and the account
 *                     they belong to (as last set by the phone over the LAN
 *                     or pulled from the cloud);
 *   seabed_open_rows  the batch being built, one CSV line per row, so a
 *                     restart loses at most the rows still held for trimming;
 *   seabed_parked     hours closed in the trip under way, as plain CSV, held
 *                     until the trip ends and trimmed by where it did;
 *   seabed_batches    closed batches as gzip BLOBs, each stamped with the
 *                     account it was logged for: queued, uploaded or
 *                     rejected. An uploaded one keeps its figures for the
 *                     status line, not its soundings, and goes after 30 days.
 *
 * BOUNDED: min(1 GiB, 10 % of the free disk), measured as the pages in use
 * (SQLite files never shrink by themselves, so the file size would stay
 * "full" for ever after one long passage). Full means capture stops taking
 * new soundings (like the ship log's OfflineQueue rejects the NEW point);
 * nothing already captured is ever dropped to make room.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
    cleanCounters,
    decodeSeabedCsv,
    encodeSeabedRow,
    parseSeabedZones,
    SEABED_CSV_HEADER,
    type SeabedCounters,
    type SeabedRow,
    type SeabedZone,
} from './seabedCore.js';

export const SEABED_DB_MAX_BYTES = 1024 * 1024 * 1024;
export const SEABED_FREE_DISK_SHARE = 0.1;
export const UPLOADED_KEEP_MS = 30 * 86_400_000;
const FULL_RECHECK_MS = 60_000;

export interface PiSeabedConfig {
    enabled: boolean;
    consentVersion: string | null;
    zones: SeabedZone[];
    sounderNote: string | null;
    vesselDraftM: number | null;
    draftConfirmed: boolean | null;
    /** When the setting was made (phone or cloud clock, ms): the newer of LAN and cloud wins. */
    updatedAt: number;
    source: 'default' | 'lan' | 'cloud';
    /** The account this Pi was paired to when it was set: the log is theirs, and only theirs. */
    ownerId: string | null;
}

export const DEFAULT_SEABED_CONFIG: PiSeabedConfig = {
    enabled: false,
    consentVersion: null,
    zones: [],
    sounderNote: null,
    vesselDraftM: null,
    draftConfirmed: null,
    updatedAt: 0,
    source: 'default',
    ownerId: null,
};

export interface NewBatch {
    tStartMs: number;
    tEndMs: number;
    rows: number;
    trackM: number;
    gz: Buffer;
    sha256: string;
    meta: Record<string, unknown>;
    counters: Record<string, unknown>;
    /** The account it was logged for. */
    ownerId: string | null;
}

/** An hour closed mid-trip, held until the trip ends. */
export interface ParkedBatch {
    csv: string;
    rows: number;
    counters: SeabedCounters;
}

export interface SaveOptions {
    /** Hours closed mid-trip to hold. */
    parked?: readonly ParkedBatch[];
    /** The trip ended: the held hours are in `batches` now, trimmed. */
    clearParked?: boolean;
    /** The account the parked hours belong to. */
    ownerId?: string | null;
}

export interface QueuedBatch {
    id: number;
    gz: Buffer;
    sha256: string;
    rows: number;
    meta: Record<string, unknown>;
    counters: Record<string, unknown>;
}

export interface SeabedStoreStats {
    pending: { batches: number; rows: number; bytes: number };
    parked: { batches: number; rows: number };
    uploaded: { batches: number; rows: number; trackM: number };
    rejected: number;
    lastUploadAt: number | null;
    openRows: number;
    storage: { bytes: number; capBytes: number };
}

export interface SeabedStoreOptions {
    /** Override the cap (tests). */
    capBytes?: number;
    now?: () => number;
}

function parseJson(text: string | null | undefined): Record<string, unknown> {
    try {
        const v = JSON.parse(text ?? '{}') as unknown;
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export class SeabedStore {
    private readonly db: Database.Database;
    private readonly dir: string;
    private readonly dbPath: string;
    /** Every statement prepared once: one prepared insert per sounding, no per-call garbage. */
    private readonly sql: Record<string, Database.Statement>;
    private fullCheckedAt = 0;
    private full = false;

    constructor(
        cacheDir: string,
        private readonly options: SeabedStoreOptions = {},
    ) {
        this.dir = path.join(cacheDir, 'seabed');
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.dbPath = path.join(this.dir, 'seabed.db');
        this.db = new Database(this.dbPath);
        // exec, not pragma(): pragma() prepares a throwaway statement on every call.
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA journal_size_limit = 67108864;
            CREATE TABLE IF NOT EXISTS seabed_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seabed_open_rows (
                seq  INTEGER PRIMARY KEY AUTOINCREMENT,
                line TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seabed_parked (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id TEXT,
                rows     INTEGER NOT NULL,
                csv      TEXT    NOT NULL,
                counters TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seabed_batches (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id        TEXT,
                t_start_ms      INTEGER NOT NULL,
                t_end_ms        INTEGER NOT NULL,
                rows            INTEGER NOT NULL,
                track_m         REAL    NOT NULL,
                bytes           INTEGER NOT NULL,
                sha256          TEXT    NOT NULL UNIQUE,
                gz              BLOB    NOT NULL,
                meta            TEXT    NOT NULL,
                counters        TEXT    NOT NULL,
                status          TEXT    NOT NULL DEFAULT 'queued',
                attempts        INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL DEFAULT 0,
                last_error      TEXT,
                created_at      INTEGER NOT NULL,
                done_at         INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_seabed_batches_status ON seabed_batches(status, t_start_ms);
        `);
        const q = (text: string) => this.db.prepare(text);
        // A store made before batches carried their account (a staged build only): add the column.
        // Kept in this.sql below, like every statement, so none is collected mid-run.
        const tableInfo = q(`SELECT name FROM pragma_table_info('seabed_batches')`);
        const columns = tableInfo.all() as { name: string }[];
        if (!columns.some((c) => c.name === 'owner_id')) {
            this.db.exec(`ALTER TABLE seabed_batches ADD COLUMN owner_id TEXT`);
        }
        this.sql = {
            tableInfo,
            insertOpen: q(`INSERT INTO seabed_open_rows (line) VALUES (?)`),
            clearOpen: q(`DELETE FROM seabed_open_rows`),
            openLines: q(`SELECT line FROM seabed_open_rows ORDER BY seq`),
            countOpen: q(`SELECT COUNT(*) AS n FROM seabed_open_rows`),
            getConfig: q(`SELECT value FROM seabed_settings WHERE key = 'config'`),
            setConfig: q(
                `INSERT INTO seabed_settings (key, value) VALUES ('config', @v) ON CONFLICT(key) DO UPDATE SET value = @v`,
            ),
            insertBatch: q(`
                INSERT OR IGNORE INTO seabed_batches
                    (owner_id, t_start_ms, t_end_ms, rows, track_m, bytes, sha256, gz, meta, counters, created_at)
                VALUES (@owner_id, @t_start_ms, @t_end_ms, @rows, @track_m, @bytes, @sha256, @gz, @meta, @counters,
                        @created_at)
            `),
            insertParked: q(`INSERT INTO seabed_parked (owner_id, rows, csv, counters) VALUES (?, ?, ?, ?)`),
            parkedAll: q(`SELECT id, csv, counters FROM seabed_parked ORDER BY id`),
            clearParked: q(`DELETE FROM seabed_parked`),
            parkedTotals: q(`SELECT COUNT(*) AS n, COALESCE(SUM(rows), 0) AS rows FROM seabed_parked`),
            due: q(
                `SELECT id, gz, sha256, rows, meta, counters FROM seabed_batches
                 WHERE status = 'queued' AND owner_id = ? AND next_attempt_at <= ? ORDER BY t_start_ms, id LIMIT ?`,
            ),
            // Sent: the figures stay for the status line, the soundings do not.
            uploaded: q(
                `UPDATE seabed_batches SET status = 'uploaded', done_at = ?, last_error = NULL, gz = X'' WHERE id = ?`,
            ),
            rejected: q(`UPDATE seabed_batches SET status = 'rejected', done_at = ?, last_error = ? WHERE id = ?`),
            defer: q(
                `UPDATE seabed_batches SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`,
            ),
            purge: q(`DELETE FROM seabed_batches`),
            prune: q(`DELETE FROM seabed_batches WHERE status != 'queued' AND done_at IS NOT NULL AND done_at < ?`),
            pending: q(
                `SELECT COUNT(*) AS n, COALESCE(SUM(rows), 0) AS rows, COALESCE(SUM(bytes), 0) AS bytes
                 FROM seabed_batches WHERE status = 'queued'`,
            ),
            uploadedBytes: q(`SELECT COALESCE(SUM(length(gz)), 0) AS n FROM seabed_batches WHERE status = 'uploaded'`),
            // The pages in use: what the cap is about, whatever the file's size.
            liveBytes: q(
                `SELECT (page_count - freelist_count) * page_size AS n
                 FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()`,
            ),
            uploadedTotals: q(
                `SELECT COUNT(*) AS n, COALESCE(SUM(rows), 0) AS rows, COALESCE(SUM(track_m), 0) AS track,
                        MAX(done_at) AS last
                 FROM seabed_batches WHERE status = 'uploaded'`,
            ),
            rejectedCount: q(`SELECT COUNT(*) AS n FROM seabed_batches WHERE status = 'rejected'`),
        };
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    // ── Settings ──

    getConfig(): PiSeabedConfig {
        const row = this.sql.getConfig.get() as { value: string } | undefined;
        const raw = parseJson(row?.value);
        const zones = parseSeabedZones(raw.zones);
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        return {
            enabled: raw.enabled === true,
            consentVersion: typeof raw.consentVersion === 'string' ? raw.consentVersion : null,
            zones: zones ?? [],
            sounderNote: typeof raw.sounderNote === 'string' ? raw.sounderNote : null,
            vesselDraftM: num(raw.vesselDraftM),
            draftConfirmed: typeof raw.draftConfirmed === 'boolean' ? raw.draftConfirmed : null,
            updatedAt: num(raw.updatedAt) ?? 0,
            source: raw.source === 'lan' || raw.source === 'cloud' ? raw.source : 'default',
            ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : null,
        };
    }

    setConfig(config: PiSeabedConfig): void {
        this.sql.setConfig.run({ v: JSON.stringify(config) });
    }

    // ── The open batch ──

    appendOpenRows(rows: readonly SeabedRow[]): void {
        if (!rows.length) return;
        this.db.transaction((batch: readonly SeabedRow[]) => {
            for (const r of batch) this.sql.insertOpen.run(encodeSeabedRow(r));
        })(rows);
    }

    openRows(): SeabedRow[] {
        const lines = this.sql.openLines.all() as { line: string }[];
        if (!lines.length) return [];
        // The Pi's clock may be anything at boot; GPS times are judged at ingest.
        const decoded = decodeSeabedCsv(`${SEABED_CSV_HEADER}\n${lines.map((l) => l.line).join('\n')}\n`, Infinity);
        return decoded.ok ? decoded.rows : [];
    }

    /**
     * Save closed batches (and hours to hold until the trip ends), and replace
     * the open rows, in ONE transaction, so a crash can neither double nor
     * lose them.
     */
    saveBatches(batches: readonly NewBatch[], openRows: readonly SeabedRow[], options: SaveOptions = {}): number[] {
        const created = this.now();
        const ids: number[] = [];
        this.db.transaction(() => {
            if (options.clearParked) this.sql.clearParked.run();
            for (const p of options.parked ?? []) {
                this.sql.insertParked.run(options.ownerId ?? null, p.rows, p.csv, JSON.stringify(p.counters));
            }
            for (const b of batches) {
                const result = this.sql.insertBatch.run({
                    owner_id: b.ownerId,
                    t_start_ms: b.tStartMs,
                    t_end_ms: b.tEndMs,
                    rows: b.rows,
                    track_m: b.trackM,
                    bytes: b.gz.byteLength,
                    sha256: b.sha256,
                    gz: b.gz,
                    meta: JSON.stringify(b.meta),
                    counters: JSON.stringify(b.counters),
                    created_at: created,
                });
                if (result.changes > 0) ids.push(Number(result.lastInsertRowid));
            }
            this.sql.clearOpen.run();
            for (const r of openRows) this.sql.insertOpen.run(encodeSeabedRow(r));
        })();
        this.fullCheckedAt = 0;
        return ids;
    }

    /** The hours held for the trip under way, oldest first. */
    parkedBatches(): { rows: SeabedRow[]; counters: SeabedCounters }[] {
        const out: { rows: SeabedRow[]; counters: SeabedCounters }[] = [];
        for (const p of this.sql.parkedAll.all() as { csv: string; counters: string }[]) {
            const decoded = decodeSeabedCsv(p.csv, Infinity);
            if (decoded.ok) out.push({ rows: decoded.rows, counters: cleanCounters(parseJson(p.counters)) });
        }
        return out;
    }

    // ── The queue ──

    /** Queued batches of THIS account only, oldest first. */
    dueBatches(nowMs: number, limit: number, ownerId: string | null): QueuedBatch[] {
        if (!ownerId) return [];
        const rows = this.sql.due.all(ownerId, nowMs, limit) as {
            id: number;
            gz: Buffer;
            sha256: string;
            rows: number;
            meta: string;
            counters: string;
        }[];
        return rows.map((r) => ({ ...r, meta: parseJson(r.meta), counters: parseJson(r.counters) }));
    }

    markUploaded(id: number, nowMs: number): void {
        this.sql.uploaded.run(nowMs, id);
    }

    markRejected(id: number, error: string, nowMs: number): void {
        this.sql.rejected.run(nowMs, error.slice(0, 200), id);
    }

    deferBatch(id: number, untilMs: number, error: string): void {
        this.sql.defer.run(untilMs, error.slice(0, 200), id);
    }

    /**
     * Switched off, soundings deleted, or the Pi changed hands: EVERY batch
     * goes (queued, uploaded and rejected), with the held hours and the open
     * rows. Nothing of this log stays on the Pi.
     */
    purgeAll(): number {
        let removed = 0;
        this.db.transaction(() => {
            removed = this.sql.purge.run().changes;
            this.sql.clearParked.run();
            this.sql.clearOpen.run();
        })();
        this.fullCheckedAt = 0;
        return removed;
    }

    /** Bytes of soundings still held for batches already sent (0: sent ones keep only their figures). */
    uploadedBytesHeld(): number {
        return (this.sql.uploadedBytes.get() as { n: number }).n;
    }

    /** Uploaded and rejected batches older than 30 days. */
    prune(nowMs: number): number {
        return this.sql.prune.run(nowMs - UPLOADED_KEEP_MS).changes;
    }

    stats(): SeabedStoreStats {
        const pending = this.sql.pending.get() as { n: number; rows: number; bytes: number };
        const uploaded = this.sql.uploadedTotals.get() as {
            n: number;
            rows: number;
            track: number;
            last: number | null;
        };
        const rejected = this.sql.rejectedCount.get() as { n: number };
        const open = this.sql.countOpen.get() as { n: number };
        const parked = this.sql.parkedTotals.get() as { n: number; rows: number };
        return {
            pending: { batches: pending.n, rows: pending.rows, bytes: pending.bytes },
            parked: { batches: parked.n, rows: parked.rows },
            uploaded: { batches: uploaded.n, rows: uploaded.rows, trackM: Math.round(uploaded.track) },
            rejected: rejected.n,
            lastUploadAt: uploaded.last,
            openRows: open.n,
            storage: { bytes: this.sizeBytes(), capBytes: this.capBytes() },
        };
    }

    // ── Bounds ──

    /** The pages in use, not the file: SQLite never gives freed pages back to the disk on its own. */
    sizeBytes(): number {
        try {
            return Number((this.sql.liveBytes.get() as { n: number }).n) || 0;
        } catch {
            return 0;
        }
    }

    capBytes(): number {
        if (this.options.capBytes !== undefined) return this.options.capBytes;
        try {
            const disk = fs.statfsSync(this.dir);
            const free = disk.bavail * disk.bsize;
            return Math.max(0, Math.min(SEABED_DB_MAX_BYTES, Math.floor(free * SEABED_FREE_DISK_SHARE)));
        } catch {
            return SEABED_DB_MAX_BYTES;
        }
    }

    /** Rechecked at most once a minute: a statfs per sounding is not worth it. */
    isFull(): boolean {
        const now = this.now();
        if (now - this.fullCheckedAt >= FULL_RECHECK_MS || now < this.fullCheckedAt) {
            this.full = this.sizeBytes() >= this.capBytes();
            this.fullCheckedAt = now;
        }
        return this.full;
    }

    checkpoint(): void {
        try {
            this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        } catch {
            // Not worth stopping the capture for.
        }
    }

    close(): void {
        try {
            this.db.close();
        } catch {
            // Already closed.
        }
    }
}
