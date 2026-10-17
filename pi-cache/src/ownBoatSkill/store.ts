/** One private, quota-bounded SQLite ledger. No network, relay or cloud queue. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
    OWN_BOAT_SKILL as LIMIT,
    OWN_BOAT_MODELS,
    ownBoatClock,
    ownBoatExact,
    ownBoatHex,
    ownBoatLabel,
    ownBoatRecord,
    ownBoatUuid,
    ownBoatBindingKey,
    parseOwnBoatConsent,
    type OwnBoatBinding,
    type OwnBoatConsent,
} from '../ownBoatSkillWire.js';
import { decodeOwnWindForecast, type CapturedWindForecast, type VerifiedWindIssue } from './forecast.js';
import type { PrivateWindSample } from './source.js';
export type { PrivateWindSample } from './source.js';
export interface SkillControl {
    schema: 1;
    generation: string;
    highWater: number;
    blockedRevision: string | null;
    active: {
        capabilityHash: string;
        consent: OwnBoatConsent;
        vesselName: string;
        logging: boolean;
        loggingApproved: boolean;
    } | null;
}
const APP_ID = 0x544f5753;
const MAX_DB = 36 * 1024 * 1024;
const MAX_CAPTURES = 1024;
const empty = (): SkillControl => ({
    schema: 1,
    generation: 'absent',
    highWater: 0,
    blockedRevision: null,
    active: null,
});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const ownSkillScope = (consent: OwnBoatConsent): string => hash(ownBoatBindingKey(consent.binding));
function parseControl(value: unknown): SkillControl {
    if (
        !ownBoatRecord(value) ||
        !ownBoatExact(value, ['schema', 'generation', 'highWater', 'blockedRevision', 'active']) ||
        value.schema !== 1 ||
        !ownBoatUuid(value.generation) ||
        !ownBoatClock(value.highWater) ||
        (value.blockedRevision !== null && !ownBoatUuid(value.blockedRevision))
    )
        throw Error('Private skill control corrupt');
    let active: SkillControl['active'] = null;
    if (value.active !== null) {
        const a = value.active,
            consent = ownBoatRecord(a) ? parseOwnBoatConsent(a.consent) : null;
        if (
            !ownBoatRecord(a) ||
            !ownBoatExact(a, ['capabilityHash', 'consent', 'vesselName', 'logging', 'loggingApproved']) ||
            !ownBoatHex(a.capabilityHash) ||
            !consent ||
            !ownBoatLabel(a.vesselName) ||
            typeof a.logging !== 'boolean' ||
            typeof a.loggingApproved !== 'boolean' ||
            (a.logging && !a.loggingApproved) ||
            value.highWater < consent.issuedAt ||
            value.blockedRevision === consent.revision
        )
            throw Error('Private skill consent corrupt');
        active = {
            capabilityHash: a.capabilityHash,
            consent,
            vesselName: a.vesselName,
            logging: a.logging,
            loggingApproved: a.loggingApproved,
        };
    }
    return {
        schema: 1,
        generation: value.generation,
        highWater: value.highWater,
        blockedRevision: value.blockedRevision as string | null,
        active,
    };
}
function validSample(value: unknown, binding: OwnBoatBinding): value is PrivateWindSample {
    if (
        !ownBoatRecord(value) ||
        !ownBoatExact(value, ['at', 'receivedAt', 'positionAt', 'cell', 'windMps', 'rawWind']) ||
        !ownBoatClock(value.at) ||
        !ownBoatClock(value.receivedAt) ||
        !ownBoatClock(value.positionAt) ||
        value.receivedAt < value.at ||
        value.receivedAt - value.at > 20_000 ||
        value.receivedAt < value.positionAt ||
        value.receivedAt - value.positionAt > 13_000 ||
        typeof value.cell !== 'string' ||
        !/^-?\d{1,4}_-?\d{1,5}$/.test(value.cell) ||
        typeof value.windMps !== 'number' ||
        !Number.isFinite(value.windMps) ||
        value.windMps < 0 ||
        value.windMps * 1.94384 > 150 ||
        typeof value.rawWind !== 'string' ||
        Buffer.byteLength(value.rawWind) > 1024
    )
        return false;
    try {
        const raw = JSON.parse(value.rawWind);
        return (
            ownBoatRecord(raw) &&
            ownBoatExact(raw, ['value', 'timestamp', '$source']) &&
            raw.value === value.windMps &&
            typeof raw.timestamp === 'string' &&
            Date.parse(raw.timestamp) === value.at &&
            ownBoatLabel(raw.$source) &&
            hash(JSON.stringify([1, binding.selfKey, 'environment.wind.speedTrue', raw.$source])) ===
                binding.windSourceKey
        );
    } catch {
        return false;
    }
}
export class OwnBoatSkillStore {
    private db: Database.Database | null = null;
    private readonly file: string;
    constructor(private readonly directory: string) {
        this.file = path.join(directory, 'private-skill.sqlite');
    }
    private open(create = false): Database.Database | null {
        if (this.db) return this.db;
        if (!fs.existsSync(this.file) && !create) return null;
        if (create) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const dir = fs.lstatSync(this.directory);
        if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== 'win32' && dir.mode & 0o077))
            throw Error('Private skill directory unavailable');
        if (fs.existsSync(this.file)) {
            const stat = fs.lstatSync(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DB)
                throw Error('Private skill file unavailable');
        }
        const db = new Database(this.file, { fileMustExist: !create, timeout: 1000 });
        try {
            fs.chmodSync(this.file, 0o600);
            const app = db.pragma('application_id', { simple: true }),
                version = db.pragma('user_version', { simple: true });
            if (
                (app !== 0 && app !== APP_ID) ||
                (version !== 0 && version !== 1) ||
                (app === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length)
            )
                throw Error('Private skill database identity refused');
            db.pragma('page_size=4096');
            if (db.pragma('page_size', { simple: true }) !== 4096) throw Error('Private skill page size refused');
            db.pragma('max_page_count=9216');
            db.pragma('journal_mode=DELETE');
            db.pragma('synchronous=FULL');
            db.pragma('secure_delete=ON');
            db.pragma('application_id=' + APP_ID);
            db.pragma('user_version=1');
            db.exec(`CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(length(value)<=16384));
                CREATE TABLE IF NOT EXISTS wind(hour INTEGER PRIMARY KEY,at INTEGER UNIQUE NOT NULL,body TEXT NOT NULL CHECK(length(body)<=2048));
                CREATE TABLE IF NOT EXISTS issues(model TEXT NOT NULL,cell TEXT NOT NULL,run INTEGER NOT NULL,captured INTEGER NOT NULL,
                    sha TEXT NOT NULL,raw BLOB NOT NULL CHECK(length(raw)<=131072),
                    metadata TEXT NOT NULL CHECK(length(metadata)<=16384),proof TEXT NOT NULL,PRIMARY KEY(model,cell,run));`);
            if (db.pragma('quick_check', { simple: true }) !== 'ok')
                throw Error('Private skill database integrity refused');
            this.db = db;
            return db;
        } catch (error) {
            db.close();
            throw error;
        }
    }
    control(): SkillControl {
        const db = this.open();
        if (!db) return empty();
        const row = db.prepare("SELECT value FROM state WHERE key='control'").get() as { value: string } | undefined;
        if (!row) return empty();
        if (Buffer.byteLength(row.value) > LIMIT.requestBytes) throw Error('Private skill control bound');
        return parseControl(JSON.parse(row.value));
    }
    private put(control: SkillControl): void {
        const raw = JSON.stringify(parseControl(control));
        if (Buffer.byteLength(raw) > LIMIT.requestBytes) throw Error('Private skill control bound');
        this.open(true)!.prepare("INSERT OR REPLACE INTO state VALUES('control',?)").run(raw);
    }
    private guard(generation: string, now: number, scope?: string): SkillControl {
        const c = this.control();
        if (
            c.generation !== generation ||
            !c.active ||
            !ownBoatClock(now) ||
            now < c.highWater - 1000 ||
            now < c.active.consent.issuedAt - 1000 ||
            now >= c.active.consent.expiresAt
        )
            throw Error('Private skill scope retired');
        if (scope && scope !== ownSkillScope(c.active.consent)) throw Error('Private skill source changed');
        const stored = this.db!.prepare("SELECT value FROM state WHERE key='scope'").get() as
            | { value: string }
            | undefined;
        if (stored?.value !== ownSkillScope(c.active.consent)) throw Error('Private evidence ownership changed');
        return c;
    }
    install(active: NonNullable<SkillControl['active']>, now: number, expected: string): SkillControl {
        const db = this.open(true)!;
        return db.transaction(() => {
            const old = this.control();
            if (old.generation !== expected || !ownBoatClock(now) || now < old.highWater - 1000)
                throw Error('Private skill install retired');
            const scope = ownSkillScope(active.consent),
                previous = db.prepare("SELECT value FROM state WHERE key='scope'").get() as
                    | { value: string }
                    | undefined;
            if (previous && previous.value !== scope) {
                db.exec('DELETE FROM wind;DELETE FROM issues;');
            }
            db.prepare("INSERT OR REPLACE INTO state VALUES('scope',?)").run(scope);
            const c: SkillControl = {
                schema: 1,
                generation: randomUUID(),
                highWater: Math.max(old.highWater, now),
                blockedRevision: old.active?.consent.revision ?? old.blockedRevision,
                active,
            };
            this.put(c);
            return c;
        })();
    }
    off(now: number, clear = false): SkillControl {
        const db = this.open();
        if (!db) return empty();
        return db.transaction(() => {
            const old = this.control();
            if (!ownBoatClock(now) && !ownBoatClock(old.highWater)) throw Error('Private skill clock unavailable');
            const c: SkillControl = {
                schema: 1,
                generation: randomUUID(),
                highWater: ownBoatClock(now) ? Math.max(now, old.highWater) : old.highWater,
                blockedRevision: old.active?.consent.revision ?? old.blockedRevision,
                active: null,
            };
            this.put(c);
            if (clear) db.exec("DELETE FROM wind;DELETE FROM issues;DELETE FROM state WHERE key='scope';");
            return c;
        })();
    }
    touch(generation: string, now: number): void {
        this.open()!.transaction(() => {
            const c = this.guard(generation, now);
            this.put({ ...c, highWater: Math.max(c.highWater, now) });
        })();
    }
    enable(generation: string, now: number): void {
        this.open()!.transaction(() => {
            const c = this.guard(generation, now);
            if (!c.active!.loggingApproved) throw Error('Private logging was not explicitly approved');
            this.put({ ...c, highWater: Math.max(c.highWater, now), active: { ...c.active!, logging: true } });
        })();
    }
    claimCaptureHour(generation: string, now: number): boolean {
        const db = this.open()!;
        return db.transaction(() => {
            const c = this.guard(generation, now);
            if (!c.active!.logging) return false;
            const hour = Math.floor(now / 3600_000);
            const prior = db.prepare("SELECT value FROM state WHERE key='capture-hour'").get() as
                | { value: string }
                | undefined;
            if (prior && (!/^\d{1,9}$/.test(prior.value) || Number(prior.value) > hour))
                throw Error('Private capture clock refused');
            if (prior && Number(prior.value) === hour) return false;
            db.prepare("INSERT OR REPLACE INTO state VALUES('capture-hour',?)").run(String(hour));
            return true;
        })();
    }
    private prune(now: number): void {
        this.db!.prepare('DELETE FROM wind WHERE at<?').run(now - LIMIT.windowMs);
        this.db!.prepare('DELETE FROM issues WHERE captured<?').run(now - LIMIT.windowMs - 72 * 3600_000);
    }
    sample(generation: string, scope: string, sample: PrivateWindSample, now: number): boolean {
        const db = this.open()!;
        return db.transaction(() => {
            const control = this.guard(generation, now, scope);
            if (!control.active!.logging) throw Error('Private logging is off');
            if (
                !validSample(sample, control.active!.consent.binding) ||
                sample.receivedAt > now ||
                now - sample.at > 20_000
            )
                throw Error('Original private wind sample refused');
            this.prune(now);
            const hour = Math.round(sample.at / 3600_000) * 3600_000;
            if (Math.abs(sample.at - hour) > 20 * 60_000) return false;
            const old = db.prepare('SELECT at FROM wind WHERE hour=?').get(hour) as { at: number } | undefined;
            if (
                old &&
                (Math.abs(old.at - hour) < Math.abs(sample.at - hour) ||
                    (Math.abs(old.at - hour) === Math.abs(sample.at - hour) && old.at <= sample.at))
            )
                return false;
            if (!old && (db.prepare('SELECT count(*) n FROM wind').get() as { n: number }).n >= LIMIT.sampleCount)
                throw Error('Private sample capacity unavailable');
            db.prepare('INSERT OR REPLACE INTO wind VALUES(?,?,?)').run(hour, sample.at, JSON.stringify(sample));
            this.put({ ...control, highWater: Math.max(control.highWater, now) });
            return true;
        })();
    }
    capture(generation: string, scope: string, issue: CapturedWindForecast, now: number): boolean {
        const db = this.open()!;
        return db.transaction(() => {
            const control = this.guard(generation, now, scope);
            if (!control.active!.logging) throw Error('Private logging is off');
            const original = decodeOwnWindForecast(issue.raw, issue.model, issue.cell, issue.capturedAt);
            if (
                !original ||
                original.sha256 !== issue.sha256 ||
                original.runAt !== issue.runAt ||
                issue.capturedAt > now ||
                now - issue.capturedAt > 10_000
            )
                throw Error('Original private issue refused');
            this.prune(now);
            if (
                db
                    .prepare('SELECT 1 FROM issues WHERE model=? AND cell=? AND run=?')
                    .get(issue.model, issue.cell, issue.runAt)
            )
                return false;
            const quota = db.prepare('SELECT count(*) n,coalesce(sum(length(raw)),0) bytes FROM issues').get() as {
                n: number;
                bytes: number;
            };
            if (quota.n >= MAX_CAPTURES || quota.bytes + issue.raw.length > LIMIT.forecastStoreBytes)
                throw Error('Private original forecast capacity unavailable');
            const metadata = JSON.stringify({
                model: original.model,
                cell: original.cell,
                runAt: original.runAt,
                capturedAt: original.capturedAt,
                points: original.points,
            });
            const proof = hash(JSON.stringify([1, original.sha256, metadata]));
            db.prepare('INSERT INTO issues VALUES(?,?,?,?,?,?,?,?)').run(
                issue.model,
                issue.cell,
                issue.runAt,
                issue.capturedAt,
                issue.sha256,
                issue.raw,
                metadata,
                proof,
            );
            this.put({ ...control, highWater: Math.max(control.highWater, now) });
            return true;
        })();
    }
    evidence(
        generation: string,
        scope: string,
        now: number,
    ): { samples: PrivateWindSample[]; issues: VerifiedWindIssue[] } {
        const db = this.open()!;
        return db.transaction(() => {
            const control = this.guard(generation, now, scope);
            const rows = db
                .prepare('SELECT hour,at,body FROM wind WHERE at>=? AND at<=? ORDER BY at LIMIT 339')
                .all(now - LIMIT.windowMs, now) as { hour: number; at: number; body: string }[];
            if (rows.length > LIMIT.sampleCount) throw Error('Private sample cohort bound');
            const samples = rows.map((row) => {
                const v = JSON.parse(row.body);
                if (
                    !validSample(v, control.active!.consent.binding) ||
                    v.at !== row.at ||
                    v.receivedAt > now ||
                    Math.round(v.at / 3600_000) * 3600_000 !== row.hour
                )
                    throw Error('Private original sample corrupt');
                return v;
            });
            const quota = db.prepare('SELECT count(*) n,coalesce(sum(length(raw)),0) bytes FROM issues').get() as {
                n: number;
                bytes: number;
            };
            if (quota.n > MAX_CAPTURES || quota.bytes > LIMIT.forecastStoreBytes)
                throw Error('Private issue cohort bound');
            const captures = db
                .prepare(
                    'SELECT model,cell,run,captured,sha,raw,metadata,proof FROM issues WHERE captured>=? ORDER BY captured LIMIT 1026',
                )
                .iterate(now - LIMIT.windowMs - 72 * 3600_000) as Iterable<{
                model: CapturedWindForecast['model'];
                cell: string;
                run: number;
                captured: number;
                sha: string;
                raw: Buffer;
                metadata: string;
                proof: string;
            }>;
            const issues: VerifiedWindIssue[] = [];
            for (const row of captures) {
                if (
                    issues.length >= MAX_CAPTURES ||
                    !Buffer.isBuffer(row.raw) ||
                    hash(row.raw) !== row.sha ||
                    row.captured > now ||
                    Buffer.byteLength(row.metadata) > 16384 ||
                    hash(JSON.stringify([1, row.sha, row.metadata])) !== row.proof
                )
                    throw Error('Private original issue corrupt');
                const m: unknown = JSON.parse(row.metadata);
                if (
                    !ownBoatRecord(m) ||
                    !ownBoatExact(m, ['model', 'cell', 'runAt', 'capturedAt', 'points']) ||
                    m.model !== row.model ||
                    !OWN_BOAT_MODELS.includes(row.model) ||
                    m.cell !== row.cell ||
                    m.runAt !== row.run ||
                    m.capturedAt !== row.captured ||
                    !Array.isArray(m.points) ||
                    !m.points.length ||
                    m.points.length > 73
                )
                    throw Error('Private original issue identity corrupt');
                let previous = 0;
                for (const point of m.points) {
                    if (
                        !Array.isArray(point) ||
                        point.length !== 2 ||
                        !ownBoatClock(point[0]) ||
                        point[0] % 3600_000 ||
                        point[0] <= row.captured ||
                        point[0] <= previous ||
                        point[0] - row.run > 72 * 3600_000 ||
                        typeof point[1] !== 'number' ||
                        !Number.isFinite(point[1]) ||
                        point[1] < 0 ||
                        point[1] > 600 / 3.6
                    )
                        throw Error('Private original issue points corrupt');
                    previous = point[0];
                }
                issues.push({
                    model: row.model,
                    cell: row.cell,
                    runAt: row.run,
                    capturedAt: row.captured,
                    sha256: row.sha,
                    points: m.points as [number, number][],
                });
            }
            return { samples, issues };
        })();
    }
    close(): void {
        this.db?.close();
        this.db = null;
    }
}
