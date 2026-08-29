/**
 * TrackStore — where the Pi's always-on track lives.
 *
 * SQLite rather than a flat log, because the point of keeping it is being able
 * to ASK it things later: where were we this time last year, what did the
 * depth do across that bar, what was the current doing off Cape Moreton on a
 * making tide. A file of coordinates answers none of those without being
 * parsed into a database first, so it may as well start as one.
 *
 * NOTHING IS AGED OUT. Measured on Calypso 2026-08-30: 875 GB free of 917 GB,
 * 1% used. A row here is roughly 60 bytes, so a point a minute is about 31 MB
 * a year — twenty-seven thousand years of disk. Shane's instinct to cap the
 * size and drop the oldest points was sound arithmetic against an SD card and
 * is simply unnecessary against a 1 TB NVMe. A cap exists anyway, far above
 * any real use, purely so a runaway writer cannot fill the boot volume and
 * take Signal K down with it.
 *
 * WAL, and a checkpoint on a schedule the caller owns. The boat's power is not
 * guaranteed and the interesting moment to survive is exactly the one where
 * something went wrong.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { TrackPoint } from './trackRecorder.js';

/** Refuse to grow past this. Chosen so it can never be reached in practice —
 *  at ~31 MB a year it is over three hundred years — while still bounding a
 *  bug that writes in a loop. */
export const TRACK_DB_MAX_BYTES = 10 * 1024 * 1024 * 1024;

export interface TrackQuery {
    fromMs: number;
    toMs: number;
    limit?: number;
}

export class TrackStore {
    private readonly db: Database.Database;
    private readonly insertStmt: Database.Statement;
    private readonly dbPath: string;

    constructor(cacheDir: string) {
        const dir = path.join(cacheDir, 'track');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.dbPath = path.join(dir, 'track.db');
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        /* NORMAL, not FULL. FULL fsyncs every write, which on a point-a-minute
           workload buys almost nothing and costs the SD/NVMe a great many
           syncs; with WAL, NORMAL still survives a process crash, and the
           worst a power cut can cost is the last checkpoint interval. */
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS track_points (
                at_ms        INTEGER NOT NULL,
                lat          REAL    NOT NULL,
                lon          REAL    NOT NULL,
                reason       TEXT    NOT NULL,
                sog_kts      REAL,
                cog_deg      REAL,
                depth_m      REAL,
                tws_kts      REAL,
                twd_deg      REAL,
                stw_kts      REAL,
                hdg_deg      REAL,
                water_temp_c REAL,
                pressure_hpa REAL,
                heel_deg     REAL
            );
            CREATE INDEX IF NOT EXISTS idx_track_at ON track_points(at_ms);
            CREATE TABLE IF NOT EXISTS track_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        this.insertStmt = this.db.prepare(`
            INSERT INTO track_points
                (at_ms, lat, lon, reason, sog_kts, cog_deg, depth_m,
                 tws_kts, twd_deg, stw_kts, hdg_deg, water_temp_c, pressure_hpa, heel_deg)
            VALUES
                (@at_ms, @lat, @lon, @reason, @sog_kts, @cog_deg, @depth_m,
                 @tws_kts, @twd_deg, @stw_kts, @hdg_deg, @water_temp_c, @pressure_hpa, @heel_deg)
        `);
    }

    /** Append points. A batch is one transaction so a crash mid-stop-close
     *  cannot leave the stop-end row without the fix that broke it. */
    append(points: TrackPoint[]): number {
        if (points.length === 0) return 0;
        if (this.sizeBytes() >= TRACK_DB_MAX_BYTES) return 0;
        const run = this.db.transaction((batch: TrackPoint[]) => {
            for (const p of batch) {
                this.insertStmt.run({
                    at_ms: p.gpsTimeMs,
                    lat: p.lat,
                    lon: p.lon,
                    reason: p.reason,
                    sog_kts: p.sogKts,
                    cog_deg: p.cogDeg,
                    depth_m: p.depthM,
                    tws_kts: p.twsKts,
                    twd_deg: p.twdDeg,
                    stw_kts: p.stwKts,
                    hdg_deg: p.hdgDeg,
                    water_temp_c: p.waterTempC,
                    pressure_hpa: p.pressureHpa,
                    heel_deg: p.heelDeg,
                });
            }
        });
        run(points);
        return points.length;
    }

    /** Points in a window, oldest first — the shape a track wants to be drawn in. */
    points(query: TrackQuery): Record<string, number | string | null>[] {
        const limit = Math.max(1, Math.min(query.limit ?? 50_000, 200_000));
        return this.db
            .prepare(`SELECT * FROM track_points WHERE at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC LIMIT ?`)
            .all(query.fromMs, query.toMs, limit) as Record<string, number | string | null>[];
    }

    /** What the log holds, for the app's settings screen to show honestly. */
    summary(): { points: number; firstMs: number | null; lastMs: number | null; bytes: number } {
        const row = this.db
            .prepare(`SELECT COUNT(*) AS n, MIN(at_ms) AS first, MAX(at_ms) AS last FROM track_points`)
            .get() as { n: number; first: number | null; last: number | null };
        return { points: row.n, firstMs: row.first, lastMs: row.last, bytes: this.sizeBytes() };
    }

    sizeBytes(): number {
        let total = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                total += fs.statSync(this.dbPath + suffix).size;
            } catch {
                // Absent WAL/SHM simply contribute nothing.
            }
        }
        return total;
    }

    /**
     * Is the recorder meant to be running?
     *
     * Persisted beside the track rather than held in memory, because the whole
     * promise is that the boat keeps her own record — a Pi that forgot it was
     * recording every time the panel was switched off would break exactly the
     * case this exists for. Default false: it is off until asked.
     */
    isEnabled(): boolean {
        const row = this.db.prepare(`SELECT value FROM track_settings WHERE key = 'enabled'`).get() as
            | { value: string }
            | undefined;
        return row?.value === '1';
    }

    setEnabled(enabled: boolean): void {
        this.db
            .prepare(
                `INSERT INTO track_settings (key, value) VALUES ('enabled', @v)
                 ON CONFLICT(key) DO UPDATE SET value = @v`,
            )
            .run({ v: enabled ? '1' : '0' });
    }

    /** Fold the WAL back into the main file. Cheap, and worth doing on a timer
     *  so an unexpected power cut costs one interval rather than a session. */
    checkpoint(): void {
        try {
            this.db.pragma('wal_checkpoint(PASSIVE)');
        } catch {
            // A checkpoint that cannot run is not worth taking the recorder down for.
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
