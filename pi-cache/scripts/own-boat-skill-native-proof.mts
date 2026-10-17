/** Disposable Linux-only real SQLite proof. Explicit command; no network or server bootstrap. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { OwnBoatSkillStore, ownSkillScope } from '../src/ownBoatSkill/store.js';
import { decodeOwnWindForecast } from '../src/ownBoatSkill/forecast.js';
import { readOwnInstrumentSource } from '../src/ownBoatSkill/source.js';
import { OWN_BOAT_SKILL, type OwnBoatConsent } from '../src/ownBoatSkillWire.js';
if (process.env.THALASSA_DISPOSABLE_OWN_SKILL_TEST !== '1' || process.platform !== 'linux')
    throw Error('Explicit disposable Linux native proof only');
const initial = Date.UTC(2026, 9, 17, 6),
    ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-skill141-'));
fs.chmodSync(root, 0o700);
let checks = 0;
const ok = (v: unknown) => {
    assert(v);
    checks++;
};
const eq = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
};
const refused = (fn: () => unknown) => {
    assert.throws(fn);
    checks++;
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
function source(now: number) {
    const v = readOwnInstrumentSource(
        {
            uuid: 'urn:mrn:imo:mmsi:503999999',
            navigation: {
                position: {
                    value: { latitude: -27.125, longitude: 153.125 },
                    timestamp: new Date(now).toISOString(),
                    $source: 'synthetic.gps',
                },
            },
            environment: {
                wind: { speedTrue: { value: 8, timestamp: new Date(now).toISOString(), $source: 'synthetic.wind' } },
            },
        },
        now,
    );
    assert(v);
    return v;
}
const instrument = source(initial);
function grant(now = initial, vesselId = ID) {
    const consent: OwnBoatConsent = {
        schema: 1,
        revision: randomUUID(),
        issuedAt: now,
        expiresAt: now + OWN_BOAT_SKILL.consentMs,
        binding: {
            ownerId: ID,
            vesselId,
            vesselRevision: 1,
            piDeviceId: ID,
            controllerId: ID,
            pairingRevision: 'a'.repeat(64),
            enrollmentRevision: 'b'.repeat(64),
            selfKey: instrument.selfKey,
            windSourceKey: instrument.windSourceKey,
            positionSourceKey: instrument.positionSourceKey,
        },
    };
    return {
        capabilityHash: sha('synthetic-capability'),
        consent,
        vesselName: 'Synthetic boat',
        logging: true,
        loggingApproved: true,
    };
}
function rawIssue(captured: number, padding = 0) {
    const run = Math.floor((captured - 3600_000) / (3 * 3600_000)) * 3 * 3600_000,
        runAt = new Date(run).toISOString(),
        hours = Array.from({ length: 96 }, (_, i) => new Date(run + i * 3600_000).toISOString());
    return Buffer.from(
        JSON.stringify([
            {
                run_at: runAt,
                payload: {
                    latitude: -27.125,
                    longitude: 153.125,
                    timezone: 'UTC',
                    utc_offset_seconds: 0,
                    thalassa_provenance: {
                        version: 2,
                        source: 'wx',
                        model: 'dwd_icon',
                        run_at: runAt,
                        cell_id: '-2725_15300',
                        cell_selection: 'sea',
                        sampling: 'cell-centre',
                        cell_degrees: 0.25,
                        latitude: -27.125,
                        longitude: 153.125,
                        source_domains: ['dwd_icon'],
                        source_runs: [{ domain: 'dwd_icon', run_at: runAt, data_end_at: hours.at(-1) }],
                    },
                    hourly_units: { time: 'iso8601', wind_speed_10m: 'km/h' },
                    hourly: { time: hours, wind_speed_10m: hours.map(() => 30) },
                    fixturePadding: 'x'.repeat(padding),
                },
            },
        ]),
    );
}
const stores: OwnBoatSkillStore[] = [];
const make = (name: string) => {
    const directory = path.join(root, name),
        store = new OwnBoatSkillStore(directory);
    stores.push(store);
    return { directory, file: path.join(directory, 'private-skill.sqlite'), store };
};
try {
    const group = fs
        .readFileSync('/proc/self/cgroup', 'utf8')
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3);
    assert(group && group.includes('own-skill141-native-proof.service'));
    const cgroupPath = path.resolve('/sys/fs/cgroup', '.' + group);
    assert(cgroupPath.startsWith('/sys/fs/cgroup/'));
    const resources = Object.fromEntries(
        ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map((name) => [
            name,
            fs.readFileSync(path.join(cgroupPath, name), 'utf8').trim(),
        ]),
    );
    eq(resources['memory.max'], String(512 * 1024 * 1024));
    eq(resources['memory.swap.max'], '0');
    eq(resources['pids.max'], '64');
    ok(Object.keys(process.env).every((key) => ['PATH', 'THALASSA_DISPOSABLE_OWN_SKILL_TEST'].includes(key)));
    const f = make('transactions');
    eq(f.store.control().active, null);
    ok(!fs.existsSync(f.directory));
    const active = grant(),
        c = f.store.install(active, initial, 'absent'),
        scope = ownSkillScope(active.consent);
    eq(fs.statSync(f.directory).mode & 0o777, 0o700);
    eq(fs.statSync(f.file).mode & 0o777, 0o600);
    ok(f.store.sample(c.generation, scope, source(initial).sample, initial));
    refused(() =>
        f.store.sample(
            c.generation,
            scope,
            {
                ...source(initial).sample,
                rawWind: JSON.stringify({
                    value: 8,
                    timestamp: new Date(initial).toISOString(),
                    $source: 'other.wind',
                }),
            },
            initial,
        ),
    );
    const issue = decodeOwnWindForecast(rawIssue(initial), 'dwd_icon', '-2725_15300', initial);
    assert(issue);
    ok(f.store.capture(c.generation, scope, issue, initial));
    eq(f.store.capture(c.generation, scope, issue, initial), false);
    refused(() => f.store.capture(c.generation, scope, { ...issue, raw: Buffer.from('changed') }, initial));
    eq(f.store.evidence(c.generation, scope, initial).issues[0].sha256, issue.sha256);
    eq(f.store.evidence(c.generation, scope, initial).samples.length, 1);
    ok(f.store.claimCaptureHour(c.generation, initial));
    eq(f.store.claimCaptureHour(c.generation, initial), false);
    f.store.close();
    eq(f.store.control().generation, c.generation);
    eq(f.store.claimCaptureHour(c.generation, initial), false);
    refused(() => f.store.touch(c.generation, initial - 2000));
    refused(() => f.store.evidence(c.generation, 'f'.repeat(64), initial));
    refused(() => f.store.install(grant(), initial, 'old-generation'));
    eq(f.store.control().generation, c.generation);
    const off = f.store.off(initial);
    eq(off.blockedRevision, active.consent.revision);
    refused(() => f.store.sample(c.generation, scope, source(initial).sample, initial));
    f.store.close();
    eq(f.store.control().blockedRevision, active.consent.revision);
    refused(() => f.store.install(active, initial, off.generation));
    const successor = grant(initial),
        next = f.store.install(successor, initial, off.generation);
    eq(f.store.evidence(next.generation, ownSkillScope(successor.consent), initial).samples.length, 1);
    const foreign = grant(initial, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        moved = f.store.install(foreign, initial, next.generation);
    eq(f.store.evidence(moved.generation, ownSkillScope(foreign.consent), initial), { samples: [], issues: [] });
    eq(f.store.claimCaptureHour(moved.generation, initial), false);
    f.store.off(initial, true);
    f.store.close();
    const inspect = new Database(f.file, { readonly: true });
    eq(inspect.prepare('SELECT count(*) n FROM wind').get(), { n: 0 });
    eq(inspect.prepare('SELECT count(*) n FROM issues').get(), { n: 0 });
    eq(inspect.pragma('page_size', { simple: true }), 4096);
    inspect.close();

    const corrupt = make('corrupt'),
        ca = grant(),
        cc = corrupt.store.install(ca, initial, 'absent');
    corrupt.store.sample(cc.generation, ownSkillScope(ca.consent), source(initial).sample, initial);
    corrupt.store.close();
    const tamper = new Database(corrupt.file);
    tamper.prepare('UPDATE wind SET body=?').run(JSON.stringify({ ...source(initial).sample, windMps: 99 }));
    tamper.close();
    refused(() => corrupt.store.evidence(cc.generation, ownSkillScope(ca.consent), initial));
    corrupt.store.close();
    const bad = new Database(corrupt.file);
    bad.prepare("UPDATE state SET value='{}' WHERE key='control'").run();
    bad.close();
    refused(() => corrupt.store.control());

    const readOnly = make('read-only'),
        ra = { ...grant(), logging: false, loggingApproved: false },
        rc = readOnly.store.install(ra, initial, 'absent');
    refused(() => readOnly.store.enable(rc.generation, initial));
    eq(readOnly.store.control().active?.logging, false);

    const quota = make('quota'),
        qa = grant(),
        qc = quota.store.install(qa, initial, 'absent'),
        qs = ownSkillScope(qa.consent);
    let retained = 0,
        bytes = 0,
        held = false;
    const capture = (v: NonNullable<ReturnType<typeof decodeOwnWindForecast>>, at: number) => {
        try {
            ok(quota.store.capture(qc.generation, qs, v, at));
            retained++;
            bytes += v.raw.length;
        } catch (error) {
            assert.match(String(error), /capacity unavailable|database or disk is full/);
            held = true;
        }
    };
    for (let i = 0; i < 112; i++) {
        const at = initial + i * 3 * 3600_000,
            raw = rawIssue(at, 126000),
            value = decodeOwnWindForecast(raw, 'dwd_icon', '-2725_15300', at);
        assert(value);
        capture(value, at);
        if (held) break;
        // Add six models/cells by using genuine distinct source cells, never an
        // issue object whose raw source disagrees with its admission identity.
        for (let j = 1; j < 3; j++) {
            const cell = `${-2725 + j * 25}_15300`,
                rows = JSON.parse(raw.toString());
            rows[0].payload.latitude += j * 0.25;
            rows[0].payload.thalassa_provenance.latitude += j * 0.25;
            rows[0].payload.thalassa_provenance.cell_id = cell;
            const changed = Buffer.from(JSON.stringify(rows)),
                v = decodeOwnWindForecast(changed, 'dwd_icon', cell, at);
            assert(v);
            capture(v, at);
            if (held) break;
        }
        if (held) break;
    }
    ok(held);
    ok(bytes <= OWN_BOAT_SKILL.forecastStoreBytes);
    ok(retained < 1024);
    const evidence = quota.store.evidence(qc.generation, qs, initial + 111 * 3 * 3600_000);
    eq(evidence.issues.length, retained);
    ok(evidence.issues.every((v) => !Object.hasOwn(v, 'raw')));
    quota.store.close();
    ok(fs.statSync(quota.file).size <= 36 * 1024 * 1024);
    eq(fs.readdirSync(quota.directory), ['private-skill.sqlite']);
    const version = new Database(':memory:');
    const sqliteVersion = version.prepare('SELECT sqlite_version() version').get();
    version.close();
    console.log(
        JSON.stringify(
            {
                schema: 1,
                result: 'pass',
                platform: process.platform,
                node: process.version,
                sqliteVersion,
                resources,
                checks,
                retainedIssues: retained,
                retainedRawBytes: bytes,
                dbBytes: fs.statSync(quota.file).size,
                peakRssKb: process.resourceUsage().maxRSS,
                wallClock: 'synthetic fixtures only; no production auth, feed or forecasts',
            },
            null,
            2,
        ),
    );
} finally {
    for (const store of stores) store.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('own-skill141-'))
        throw Error('Disposable proof cleanup refused');
    fs.rmSync(root, { recursive: true, force: true });
}
