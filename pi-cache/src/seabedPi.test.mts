/**
 * Seabed mapping on the Pi: the Signal K reader, the store, the runner, the
 * uploader and the routes. FICTIONAL data only (open water in the Tasman, a
 * made-up 2030 calendar): the repo is public, and no real track, position or
 * sounding from any boat belongs in it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readSounding, sounderProduct } from './seabed/seabedReader.js';
import { SeabedStore, type PiSeabedConfig } from './seabed/seabedStore.js';
import { SeabedRunner } from './seabed/seabedRunner.js';
import { SeabedUploader } from './seabed/seabedUploader.js';
import { createSeabedRoutes } from './routes/seabed.js';
import { bindSeabedOwner, configFromCloud } from './seabed/attach.js';
import { SEABED_CSV_HEADER, SEABED_FLAG, decodeSeabedCsv, distanceM } from './seabed/seabedCore.js';

const RAD = Math.PI / 180;
const T0 = Date.UTC(2030, 0, 1, 2, 0, 0);
/** The Pi's clock runs 2.5 s behind GPS: rows must carry GPS time, not the Pi's. */
const GPS_AHEAD_MS = 2_500;
const LAT0 = -30.5;
const LON0 = 160.2;
const OWNER = '00000000-0000-4000-8000-000000000001';
const NEW_OWNER = '00000000-0000-4000-8000-000000000002';
const M_PER_DEG_LAT = 111_195;

const iso = (ms: number) => new Date(ms).toISOString();

interface DocOptions {
    lat?: number;
    lon?: number;
    sogKn?: number;
    depth?: number | null;
    depthAt?: number;
    datetime?: boolean;
    keel?: { belowKeel: number; transducerToKeel: number } | null;
    surface?: number | null;
}

/** A self document shaped like Signal K's REST answer. */
function selfDoc(now: number, o: DocOptions = {}): Record<string, unknown> {
    const at = iso(now);
    const depth: Record<string, unknown> = {};
    if (o.depth !== null) {
        depth.belowTransducer = { value: o.depth ?? 42.5, $source: 'sounder.1', timestamp: iso(o.depthAt ?? now) };
    }
    if (o.keel) {
        depth.belowKeel = { value: o.keel.belowKeel, $source: 'sounder.1', timestamp: at };
        depth.transducerToKeel = { value: o.keel.transducerToKeel, $source: 'sounder.1', timestamp: at };
    }
    if (o.surface !== undefined && o.surface !== null) {
        depth.belowSurface = { value: o.surface, $source: 'sounder.1', timestamp: at };
    }
    const navigation: Record<string, unknown> = {
        position: { value: { latitude: o.lat ?? LAT0, longitude: o.lon ?? LON0 }, $source: 'gps.1', timestamp: at },
        speedOverGround: { value: (o.sogKn ?? 6) / 1.94384, $source: 'gps.1', timestamp: at },
        courseOverGroundTrue: { value: 10 * RAD, $source: 'gps.1', timestamp: at },
        headingTrue: { value: 12 * RAD, $source: 'compass.1', timestamp: at },
        gnss: {
            methodQuality: { value: 'GNSS Fix', $source: 'gps.1', timestamp: at },
            horizontalDilution: { value: 0.9, $source: 'gps.1', timestamp: at },
            satellites: { value: 11, $source: 'gps.1', timestamp: at },
        },
    };
    if (o.datetime !== false) navigation.datetime = { value: iso(now + GPS_AHEAD_MS), timestamp: at };
    return { navigation, environment: { depth } };
}

/**
 * better-sqlite3 11 on the Mac's Node 24 can crash finalising a closed
 * database's statements during GC (the trackStore teardown crash in the
 * 2026-10-04 router stage evidence). Keeping every store referenced until the
 * process exits keeps those finalisers from running mid-suite. The Pi and CI
 * run Node 22, where this does not happen.
 */
const alive: SeabedStore[] = [];
function keep(store: SeabedStore): SeabedStore {
    alive.push(store);
    return store;
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-seabed-'));
}

const gzip = (text: string) =>
    new Promise<Buffer>((resolve, reject) => zlib.gzip(text, (e, b) => (e ? reject(e) : resolve(b))));

function enabledConfig(over: Partial<PiSeabedConfig> = {}): PiSeabedConfig {
    return {
        enabled: true,
        consentVersion: '2026-10-05',
        zones: [],
        sounderNote: null,
        vesselDraftM: 2.1,
        draftConfirmed: true,
        updatedAt: T0 - 60_000,
        source: 'lan',
        ownerId: OWNER,
        ...over,
    };
}

// ── Reader ────────────────────────────────────────────────────────────────

test('reads depth below the transducer with its own time, GPS time offset, knots and the GNSS of the position source', () => {
    const now = T0;
    const s = readSounding(selfDoc(now, { depth: 17.25, depthAt: now - 400 }), now);
    assert.equal(s.depth?.value, 17.25);
    assert.equal(s.depth?.ref, 'T');
    assert.equal(s.depth?.derived, false);
    assert.equal(s.depth?.atMs, now - 400);
    assert.equal(s.gpsOffsetMs, GPS_AHEAD_MS);
    assert.ok(Math.abs((s.sogKn ?? 0) - 6) < 1e-9);
    assert.ok(Math.abs((s.cogDeg ?? 0) - 10) < 1e-9);
    assert.equal(s.fixQ, 1);
    assert.equal(s.hdop, 0.9);
    assert.equal(s.sats, 11);
    assert.deepEqual(s.fix, { lat: LAT0, lon: LON0 });
    assert.equal(s.positionSource, 'gps.1');
});

test('no transducer reading: keel depth plus the keel offset is used and marked derived', () => {
    const s = readSounding(selfDoc(T0, { depth: null, keel: { belowKeel: 2.96, transducerToKeel: 1.8 } }), T0);
    assert.equal(s.depth?.value, 4.76);
    assert.equal(s.depth?.ref, 'T');
    assert.equal(s.depth?.derived, true);
});

test('the DBS trap: with a keel setting on the bus, belowSurface is never used', () => {
    const doc = selfDoc(T0, { depth: null, surface: 2.96 });
    const env = doc.environment as { depth: Record<string, unknown> };
    env.depth.transducerToKeel = { value: 1.8, timestamp: iso(T0 - 600_000) };
    assert.equal(readSounding(doc, T0).depth, null);
    // A sounder with no keel setting reports DBS from the waterline.
    const plain = readSounding(selfDoc(T0, { depth: null, surface: 9.5 }), T0);
    assert.equal(plain.depth?.value, 9.5);
    assert.equal(plain.depth?.ref, 'W');
});

test('a stale depth and a missing GPS clock are both refused', () => {
    assert.equal(readSounding(selfDoc(T0, { depthAt: T0 - 30_000 }), T0).depth, null);
    assert.equal(readSounding(selfDoc(T0, { datetime: false }), T0).gpsOffsetMs, null);
});

test('the sounder product comes from the N2K source tree, never a serial number', () => {
    const sources = { can0: { '35': { n2k: { manufacturerName: 'Acme Marine', modelId: 'DST-1', serial: '9' } } } };
    assert.equal(sounderProduct(sources, 'can0.35'), 'Acme Marine DST-1');
    assert.equal(sounderProduct(sources, 'nmea0183.II'), null);
});

// ── Runner + store ────────────────────────────────────────────────────────

function rig(over: { cap?: number } = {}) {
    const dir = tmpDir();
    const store = keep(new SeabedStore(dir, { capBytes: over.cap }));
    store.setConfig(enabledConfig());
    let now = T0;
    let doc: Record<string, unknown> | null = selfDoc(now);
    const runner = new SeabedRunner({
        read: async () => doc,
        store,
        gzip,
        now: () => now,
        log: () => undefined,
    });
    return {
        dir,
        store,
        runner,
        at: (t: number, o: DocOptions = {}) => {
            now = t;
            doc = o === null ? null : selfDoc(t, o);
        },
    };
}

/** Sail north at `kn` for `seconds`, one tick a second, a fresh sounding each tick. */
async function sail(r: ReturnType<typeof rig>, from: number, seconds: number, kn = 6, lat0 = LAT0) {
    const mPerS = kn * 0.514444;
    for (let i = 0; i < seconds; i++) {
        const t = from + i * 1000;
        r.at(t, { lat: lat0 + (i * mPerS) / 111_195, sogKn: kn, depth: 40 + (i % 7) * 0.1 });
        await r.runner.tick();
    }
}

test('a whole trip: under way, rows to the open table, a gzipped batch when she stops', async () => {
    const r = rig();
    await sail(r, T0, 900);
    assert.equal(r.runner.describe().underway, true);
    const open = r.store.openRows();
    assert.ok(open.length > 300, `open rows ${open.length}`);
    assert.equal(open[0].timeMs % 1000, GPS_AHEAD_MS % 1000, 'row time is GPS time');
    // She stops: 60 s under 0.8 kn.
    const lat = LAT0 + (899 * 6 * 0.514444) / 111_195;
    for (let i = 1; i <= 62; i++) {
        r.at(T0 + 900_000 + i * 1000, { lat, sogKn: 0.2 });
        await r.runner.tick();
    }
    assert.equal(r.runner.describe().underway, false);
    assert.equal(r.store.openRows().length, 0);
    const due = r.store.dueBatches(Date.now(), 10, OWNER);
    assert.equal(due.length, 1);
    const text = zlib.gunzipSync(due[0].gz).toString('utf8');
    assert.ok(text.startsWith(`${SEABED_CSV_HEADER}\n`));
    const decoded = decodeSeabedCsv(text, Infinity);
    assert.ok(decoded.ok);
    assert.equal(decoded.ok && decoded.rows.length, open.length);
    assert.equal(due[0].meta.device, 'pi');
    assert.equal(due[0].meta.time_source, 'gnss');
    assert.ok(Number(due[0].counters.trim_dropped) > 150, 'both ends of the trip trimmed');
    r.store.close();
});

test('a depth leaf whose timestamp has not moved is a re-read, not a sounding', async () => {
    const r = rig();
    // A sounder that updates every 3 s, read every second: two reads in three repeat one measurement.
    for (let i = 0; i <= 30; i++) {
        r.at(T0 + i * 1000, { lat: LAT0 + i * 0.00003, sogKn: 6, depthAt: T0 + Math.floor(i / 3) * 3000 });
        await r.runner.tick();
    }
    assert.equal(r.runner.describe().underway, true);
    assert.equal(r.runner.describe().counters.rereads_skipped, 6);
    assert.equal(r.runner.describe().counters.too_soon, 0, 'a re-read never reaches the 900 ms rule');
    r.store.close();
});

test('no GPS clock on the bus: no row at all', async () => {
    const r = rig();
    for (let i = 0; i <= 40; i++) {
        r.at(T0 + i * 1000, { lat: LAT0 + i * 0.00003, sogKn: 6, datetime: false });
        await r.runner.tick();
    }
    assert.ok(r.runner.describe().counters.no_gps_time > 10);
    assert.equal(r.store.openRows().length, 0);
    r.store.close();
});

test('rows left open by a restart come back as one recovered batch', async () => {
    const r = rig();
    await sail(r, T0, 600);
    const open = r.store.openRows().length;
    assert.ok(open > 0);
    r.store.close();
    const store = keep(new SeabedStore(r.dir));
    const runner = new SeabedRunner({ read: async () => null, store, gzip, now: () => T0 + 700_000 });
    await runner.recover();
    assert.equal(store.openRows().length, 0);
    const due = store.dueBatches(Date.now(), 10, OWNER);
    assert.equal(due.length, 1);
    assert.ok(due[0].rows > 0 && due[0].rows < open, 'the last 500 m before the restart are trimmed');
    assert.equal(due[0].meta.recovered, true);
    store.close();
});

test('switched off, nothing is read and nothing is written', async () => {
    const r = rig();
    r.store.setConfig(enabledConfig({ enabled: false }));
    let reads = 0;
    const runner = new SeabedRunner({
        read: async () => {
            reads += 1;
            return selfDoc(T0);
        },
        store: r.store,
        gzip,
        now: () => T0,
    });
    await runner.tick();
    assert.equal(reads, 0);
    r.store.close();
});

test('a full store stops taking soundings and says so, without dropping what it holds', async () => {
    const r = rig({ cap: 1 });
    await sail(r, T0, 120);
    assert.equal(r.store.openRows().length, 0);
    assert.equal(r.runner.describe().full, true);
    r.store.close();
});

test('the store keeps totals of uploaded batches without their soundings, and prunes them after 30 days', async () => {
    const dir = tmpDir();
    const store = keep(new SeabedStore(dir));
    const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
    const base = {
        tStartMs: T0,
        tEndMs: T0 + 1000,
        rows: 10,
        trackM: 120,
        meta: { device: 'pi' },
        counters: {},
        ownerId: OWNER,
    };
    const a = store.saveBatches([{ ...base, gz, sha256: 'a'.repeat(64) }], [])[0];
    store.saveBatches([{ ...base, gz, sha256: 'b'.repeat(64) }], []);
    store.markUploaded(a, T0);
    assert.equal(store.stats().uploaded.rows, 10);
    assert.equal(store.uploadedBytesHeld(), 0, 'an uploaded batch keeps its figures, not its positions');
    assert.equal(store.prune(T0 + 31 * 86_400_000), 1);
    assert.equal(store.stats().uploaded.batches, 0);
    assert.equal(store.stats().pending.batches, 1);
    store.close();
});

test('switched off or deleted: every batch goes, uploaded and rejected too, with the open and held rows', async () => {
    const r = rig();
    await sail(r, T0 + 3_000_000, 900); // across 03:00, so an hour is held for the trip end
    assert.ok(r.store.stats().parked.batches >= 1);
    const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
    const base = { tStartMs: T0, tEndMs: T0 + 1, rows: 1, trackM: 1, gz, meta: {}, counters: {}, ownerId: OWNER };
    const [up, bad] = r.store.saveBatches(
        [
            { ...base, sha256: 'e'.repeat(64) },
            { ...base, sha256: 'f'.repeat(64) },
        ],
        r.store.openRows(),
    );
    r.store.markUploaded(up, T0);
    r.store.markRejected(bad, 'line 2: bad time', T0);
    r.store.purgeAll();
    const stats = r.store.stats();
    assert.deepEqual(
        [stats.pending.batches, stats.uploaded.batches, stats.rejected, stats.parked.batches, stats.openRows],
        [0, 0, 0, 0, 0],
    );
    r.store.close();
});

test('the cap counts the pages in use, so logging resumes once the store is emptied', async () => {
    const dir = tmpDir();
    let now = T0;
    const store = keep(new SeabedStore(dir, { capBytes: 600_000, now: () => now }));
    const noise = () => randomBytes(60_000); // incompressible, like a real hour of soundings is not
    for (let i = 0; i < 20; i++) {
        store.saveBatches(
            [
                {
                    tStartMs: T0 + i,
                    tEndMs: T0 + i + 1,
                    rows: 1,
                    trackM: 1,
                    gz: noise(),
                    sha256: i.toString(16).padStart(64, '0'),
                    meta: {},
                    counters: {},
                    ownerId: OWNER,
                },
            ],
            [],
        );
    }
    assert.equal(store.isFull(), true);
    store.purgeAll();
    now += 61_000;
    assert.equal(store.isFull(), false, 'the file has not shrunk, but its pages are free');
    store.close();
});

test("only the paired owner's batches are ever offered for upload", async () => {
    const dir = tmpDir();
    const store = keep(new SeabedStore(dir));
    const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
    const base = { tStartMs: T0, tEndMs: T0 + 1, rows: 1, trackM: 1, gz, meta: {}, counters: {} };
    store.saveBatches(
        [
            { ...base, sha256: '1'.repeat(64), ownerId: OWNER },
            { ...base, sha256: '2'.repeat(64), ownerId: NEW_OWNER },
        ],
        [],
    );
    assert.equal(store.dueBatches(Date.now(), 10, OWNER).length, 1);
    assert.equal(store.dueBatches(Date.now(), 10, NEW_OWNER).length, 1);
    assert.equal(store.dueBatches(Date.now(), 10, null).length, 0);
    store.close();
});

// ── The end of a trip ─────────────────────────────────────────────────────

/** Legs along the meridian: [metres north (negative = south), knots], then `still` seconds lying still. */
async function legs(
    r: ReturnType<typeof rig>,
    from: number,
    lat0: number,
    plan: Array<[number, number]>,
    still: number,
) {
    let t = from;
    let lat = lat0;
    for (const [metres, kn] of plan) {
        const mPerS = kn * 0.514444;
        const steps = Math.round(Math.abs(metres) / mPerS);
        for (let i = 0; i < steps; i++) {
            lat += (Math.sign(metres) * mPerS) / M_PER_DEG_LAT;
            t += 1000;
            r.at(t, { lat, sogKn: kn, depth: 40 + (i % 7) * 0.1 });
            await r.runner.tick();
        }
    }
    for (let i = 1; i <= still; i++) {
        r.at(t + i * 1000, { lat, sogKn: 0.2 });
        await r.runner.tick();
    }
    return lat;
}

function queuedRows(store: SeabedStore) {
    return store.dueBatches(Date.now(), 100, OWNER).flatMap((b) => {
        const decoded = decodeSeabedCsv(zlib.gunzipSync(b.gz).toString('utf8'), Infinity);
        assert.ok(decoded.ok);
        return decoded.ok ? decoded.rows : [];
    });
}

test('nothing near where she stopped is queued, even after passing it an hour earlier and coming back', async () => {
    const r = rig();
    // 02:30: 5 km north to F (about 02:57), 2 km past it, back to F, then lying still.
    // The first pass over F closes with the 02:xx hour, which is held until the trip ends.
    const end = await legs(
        r,
        Date.UTC(2030, 0, 1, 2, 30, 0),
        LAT0 - 5000 / M_PER_DEG_LAT,
        [
            [5000, 6],
            [2000, 6],
            [-2000, 6],
        ],
        70,
    );
    assert.equal(r.runner.describe().underway, false);
    assert.equal(r.store.stats().parked.batches, 0);
    assert.ok(r.store.dueBatches(Date.now(), 100, OWNER).length >= 2);
    const rows = queuedRows(r.store);
    assert.ok(rows.length > 1000, `rows ${rows.length}`);
    const nearest = Math.min(...rows.map((x) => distanceM(x.lat, x.lon, end, LON0)));
    // 499.5, not 500: the CSV keeps 6 decimals of a degree, ~0.1 m.
    assert.ok(nearest >= 499.5, `a row ${nearest.toFixed(1)} m from where she stopped`);
    r.store.close();
});

test('a restart mid-trip: the held hour and the open rows come back, trimmed by her last row', async () => {
    const r = rig();
    await sail(r, Date.UTC(2030, 0, 1, 2, 50, 0), 900); // 02:50 to 03:05 north
    assert.equal(r.store.stats().parked.batches, 1);
    const open = r.store.openRows();
    const last = open[open.length - 1];
    r.store.close();
    const store = keep(new SeabedStore(r.dir));
    const runner = new SeabedRunner({ read: async () => null, store, gzip, now: () => T0 + 7_200_000 });
    await runner.recover();
    assert.equal(store.stats().parked.batches, 0);
    assert.equal(store.openRows().length, 0);
    const rows = queuedRows(store);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((x) => distanceM(x.lat, x.lon, last.lat, last.lon) >= 499.5));
    assert.ok(store.dueBatches(Date.now(), 10, OWNER).every((b) => b.meta.recovered === true));
    store.close();
});

// ── Whose log it is ───────────────────────────────────────────────────────

test('the log belongs to the account the Pi is paired to: re-paired or unpaired, it starts again from nothing', async () => {
    const r = rig();
    await sail(r, T0, 600);
    assert.ok(r.store.openRows().length > 0);
    const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
    r.store.saveBatches(
        [
            {
                tStartMs: T0,
                tEndMs: T0 + 1,
                rows: 1,
                trackM: 1,
                gz,
                sha256: '9'.repeat(64),
                meta: {},
                counters: {},
                ownerId: OWNER,
            },
        ],
        r.store.openRows(),
    );
    r.runner.start();
    assert.equal(bindSeabedOwner(r.store, r.runner, OWNER), false, 'same owner: nothing to do');
    assert.equal(bindSeabedOwner(r.store, r.runner, NEW_OWNER), true);
    const stats = r.store.stats();
    assert.deepEqual([stats.pending.batches, stats.openRows, stats.parked.batches], [0, 0, 0]);
    assert.equal(r.store.getConfig().enabled, false);
    assert.equal(r.store.getConfig().ownerId, NEW_OWNER);
    assert.equal(r.runner.describe().running, false);
    assert.equal(r.runner.describe().heldRows, 0, 'nothing of the old trip is left in memory either');
    assert.equal(bindSeabedOwner(r.store, r.runner, NEW_OWNER), false);

    r.store.setConfig(enabledConfig({ ownerId: NEW_OWNER }));
    assert.equal(bindSeabedOwner(r.store, r.runner, null), true, 'unpaired: off, and nobody can be logged for');
    assert.equal(r.store.getConfig().enabled, false);
    assert.equal(r.store.getConfig().ownerId, null);
    r.store.close();
});

// ── Uploader ──────────────────────────────────────────────────────────────

interface Call {
    action: string;
    body: Record<string, unknown>;
}

function uploaderRig(replies: Array<(call: Call) => { status: number; body?: unknown }>) {
    const dir = tmpDir();
    const store = keep(new SeabedStore(dir));
    const calls: Call[] = [];
    const configs: unknown[] = [];
    let internet = true;
    let now = T0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const call = { action: String(body.action), body };
        calls.push(call);
        const reply = (replies.shift() ?? (() => ({ status: 200, body: { ok: true } })))(call);
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            json: async () => reply.body ?? {},
        };
    }) as unknown as typeof fetch;
    const uploader = new SeabedUploader({
        fetchImpl,
        endpoint: 'https://example.invalid/functions/v1/seabed-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-0000000000000001', token: 'f'.repeat(64) }),
        internetAllowed: () => internet,
        store,
        onConfig: (c) => configs.push(c),
        ownerId: () => OWNER,
        now: () => now,
        log: () => undefined,
    });
    const queue = async (n: number) => {
        for (let i = 0; i < n; i++) {
            const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
            store.saveBatches(
                [
                    {
                        tStartMs: T0 + i,
                        tEndMs: T0 + i + 1,
                        rows: 1,
                        trackM: 1,
                        gz,
                        sha256: String(i).repeat(64).slice(0, 64),
                        meta: {},
                        counters: {},
                        ownerId: OWNER,
                    },
                ],
                [],
            );
        }
    };
    return {
        store,
        calls,
        configs,
        uploader,
        queue,
        setInternet: (v: boolean) => (internet = v),
        advance: (ms: number) => (now += ms),
    };
}

const configOk = () => ({ status: 200, body: { boat_id: 'b', platform: null } });

test('uploads the oldest batches after pulling the config, and marks them uploaded', async () => {
    const u = uploaderRig([
        configOk,
        () => ({ status: 200, body: { ok: true } }),
        () => ({ status: 200, body: { ok: true, duplicate: true } }),
    ]);
    await u.queue(2);
    assert.equal(await u.uploader.cycle(), 'sent');
    assert.deepEqual(
        u.calls.map((c) => c.action),
        ['config', 'batch', 'batch'],
    );
    assert.equal(u.calls[1].body.encoding, 'gzip');
    assert.equal(u.calls[1].body.device, 'pi');
    assert.equal(u.store.stats().pending.batches, 0);
    assert.equal(u.configs.length, 1);
    u.store.close();
});

test('consent withdrawn (409 not-enabled): every queued batch is purged', async () => {
    const u = uploaderRig([configOk, () => ({ status: 409, body: { code: 'not-enabled' } })]);
    await u.queue(3);
    assert.equal(await u.uploader.cycle(), 'not-enabled');
    assert.equal(u.store.stats().pending.batches, 0);
    u.store.close();
});

test('a function that is not deployed yet (404) is left alone for 12 hours, quietly', async () => {
    const u = uploaderRig([() => ({ status: 404 })]);
    await u.queue(1);
    assert.equal(await u.uploader.cycle(), 'not-deployed');
    u.advance(6 * 3_600_000);
    assert.equal(await u.uploader.cycle(), 'waiting');
    assert.equal(u.calls.length, 1);
    u.advance(6 * 3_600_000 + 1);
    await u.uploader.cycle();
    assert.equal(u.calls.length > 1, true);
    assert.equal(u.store.stats().pending.batches, 0);
    u.store.close();
});

test('a batch the function refuses (422) is kept as rejected and never retried', async () => {
    const u = uploaderRig([configOk, () => ({ status: 422, body: { error: 'line 2: bad time' } })]);
    await u.queue(1);
    await u.uploader.cycle();
    assert.equal(u.store.stats().pending.batches, 0);
    assert.equal(u.store.stats().rejected, 1);
    u.store.close();
});

test('no platform yet (409 no-platform): the batch waits six hours', async () => {
    const u = uploaderRig([configOk, () => ({ status: 409, body: { code: 'no-platform' } })]);
    await u.queue(1);
    assert.equal(await u.uploader.cycle(), 'no-platform');
    assert.equal(u.store.dueBatches(T0 + 1000, 10, OWNER).length, 0);
    assert.equal(u.store.dueBatches(T0 + 6 * 3_600_000 + 1, 10, OWNER).length, 1);
    u.store.close();
});

test('another device logs this boat now (409 not-logger): the batch waits six hours', async () => {
    const u = uploaderRig([configOk, () => ({ status: 409, body: { code: 'not-logger' } })]);
    await u.queue(1);
    assert.equal(await u.uploader.cycle(), 'not-logger');
    assert.equal(u.store.dueBatches(T0 + 1000, 10, OWNER).length, 0);
    assert.equal(u.store.dueBatches(T0 + 6 * 3_600_000 + 1, 10, OWNER).length, 1);
    u.store.close();
});

test('the satellite policy blocks every request', async () => {
    const u = uploaderRig([]);
    await u.queue(1);
    u.setInternet(false);
    assert.equal(await u.uploader.cycle(), 'internet-off');
    assert.equal(u.calls.length, 0);
    u.store.close();
});

// ── Routes ────────────────────────────────────────────────────────────────

function routeRig(ownerId: string | null) {
    const dir = tmpDir();
    const store = keep(new SeabedStore(dir));
    const applied: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use(
        '/api/seabed',
        createSeabedRoutes({
            store,
            ownerId: () => ownerId,
            apply: (cfg) => applied.push(cfg),
            describe: () => ({ underway: false, capturing: false, full: false, counters: {}, lastOutcome: null }),
            uploaderStatus: () => ({ lastOutcome: null, lastUploadAt: null }),
        }),
    );
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/seabed`;
    return { store, applied, base, close: () => (server.close(), store.close()) };
}

const zone = { id: 'home-1', kind: 'home', lat: LAT0, lon: LON0, radius_m: 1000, jitter_m: 250 };

test('POST /config persists before acting, and refuses a different owner', async () => {
    const r = routeRig(OWNER);
    const post = (body: unknown) =>
        fetch(`${r.base}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const good = { enabled: true, consent_version: '2026-10-05', zones: [zone], owner_id: OWNER, updated_at: T0 };
    assert.equal((await post({ ...good, owner_id: '00000000-0000-4000-8000-000000000009' })).status, 403);
    assert.equal((await post({ ...good, zones: [{ ...zone, radius_m: 10 }] })).status, 400);
    assert.equal((await post({ ...good, enabled: 'yes' })).status, 400);
    assert.equal(
        (await post({ ...good, consent_version: '2020-01-01' })).status,
        409,
        "switching on needs today's consent",
    );
    const ok = await post(good);
    assert.equal(ok.status, 200);
    assert.equal(r.store.getConfig().enabled, true);
    assert.equal(r.store.getConfig().zones.length, 1);
    assert.equal(r.store.getConfig().ownerId, OWNER);
    assert.equal(r.applied.length, 1);
    // A phone that does not know the zones says nothing about them: the Pi keeps its own.
    const { zones: _z, ...withoutZones } = good;
    assert.equal((await post({ ...withoutZones, updated_at: T0 + 1 })).status, 200);
    assert.equal(r.store.getConfig().zones.length, 1);
    const status = (await (await fetch(`${r.base}/status`)).json()) as Record<string, unknown>;
    assert.equal(status.enabled, true);
    assert.equal(status.zones, 1);
    assert.ok(typeof (status.storage as Record<string, unknown>).capBytes === 'number');
    r.close();
});

test('logging moved to a phone stops this Pi but keeps what it holds; switching off purges it', async () => {
    const r = routeRig(OWNER);
    const gz = await gzip(`${SEABED_CSV_HEADER}\n`);
    const batch = {
        tStartMs: T0,
        tEndMs: T0 + 1,
        rows: 1,
        trackM: 1,
        gz,
        sha256: 'd'.repeat(64),
        meta: {},
        counters: {},
    };
    r.store.saveBatches([{ ...batch, ownerId: OWNER }], []);
    const post = (body: unknown) =>
        fetch(`${r.base}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const base = { consent_version: '2026-10-05', zones: [], owner_id: OWNER, updated_at: T0 };
    assert.equal((await post({ ...base, enabled: true, logger: 'phone' })).status, 200);
    assert.equal(r.store.getConfig().enabled, false);
    assert.equal(r.store.stats().pending.batches, 1, 'moved, not withdrawn: the queue stays');
    assert.equal((await post({ ...base, enabled: false })).status, 200);
    assert.equal(r.store.stats().pending.batches, 0, 'switched off: the queue goes');
    r.close();
});

test('the cloud config: newer LAN pushes win, a phone logger is not a withdrawal, OFF is', () => {
    const current = { ...enabledConfig(), updatedAt: Date.parse('2030-01-01T00:10:00Z') };
    const fromCloud = (answer: Record<string, unknown>, cur = current) => configFromCloud(answer, cur, OWNER);
    const platform = {
        enabled: true,
        consent_version: '2026-10-05',
        capture: 'pi',
        zones: [zone],
        vessel: { draft_m: 2.4, draft_confirmed: true },
        updated_at: '2030-01-01T00:20:00Z',
    };
    assert.equal(fromCloud({ platform: null }), null, 'the owner set it over the LAN; the cloud has not caught up');
    const gone = fromCloud({ platform: null }, { ...current, source: 'cloud' });
    assert.deepEqual([gone?.config.enabled, gone?.withdrawn], [false, true], 'the cloud row is gone: off');
    const foreign = fromCloud({ platform: null }, { ...current, ownerId: NEW_OWNER });
    assert.equal(foreign?.config.enabled, false, 'a LAN push from someone else does not keep it on');
    assert.equal(fromCloud({ platform: null }, { ...current, enabled: false }), null, 'already off');
    assert.equal(fromCloud({ platform: { ...platform, updated_at: '2030-01-01T00:05:00Z' } }), null);
    const on = fromCloud({ platform });
    assert.equal(on?.config.enabled, true);
    assert.equal(on?.config.vesselDraftM, 2.4);
    assert.equal(on?.config.zones.length, 1);
    assert.equal(on?.config.ownerId, OWNER);
    const moved = fromCloud({ platform: { ...platform, capture: 'phone' } });
    assert.deepEqual([moved?.config.enabled, moved?.withdrawn], [false, false]);
    const off = fromCloud({ platform: { ...platform, enabled: false } });
    assert.deepEqual([off?.config.enabled, off?.withdrawn], [false, true]);
    const stale = fromCloud({ platform: { ...platform, consent_version: '2020-01-01' } });
    assert.equal(stale?.config.enabled, false);
});

test('an unpaired Pi refuses the switch: it has no account to keep soundings in', async () => {
    const r = routeRig(null);
    const res = await fetch(`${r.base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            enabled: true,
            consent_version: '2026-10-05',
            zones: [],
            owner_id: OWNER,
            updated_at: T0,
        }),
    });
    assert.equal(res.status, 409);
    r.close();
});

// ── The server wiring ─────────────────────────────────────────────────────

test('server.ts wires seabed in with one import and one call, behind the app gate', () => {
    const server = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    assert.equal((server.match(/attachSeabed/g) ?? []).length, 2, 'one import and one call');
    assert.equal((server.match(/seabed/gi) ?? []).length, 3, 'and no other mention');
    assert.match(server, /import \{ attachSeabed \} from '\.\/seabed\/attach\.js';/);
    assert.match(server, /attachSeabed\(\{[\s\S]*?appApiEnabled: APP_API_ENABLED,[\s\S]*?requireAppApi,[\s\S]*?\}\);/);
    const attach = fs.readFileSync(new URL('./seabed/attach.ts', import.meta.url), 'utf8');
    assert.match(attach, /app\.use\('\/api\/seabed', requireAppApi\)/);
    assert.match(attach, /if \(options\.appApiEnabled\)/);
});

test('a derived depth is flagged as derived in the row', async () => {
    const r = rig();
    for (let i = 0; i <= 700; i++) {
        r.at(T0 + i * 1000, {
            lat: LAT0 + (i * 3.0866) / 111_195,
            sogKn: 6,
            depth: null,
            keel: { belowKeel: 10 + (i % 3) * 0.1, transducerToKeel: 1.8 },
        });
        await r.runner.tick();
    }
    const open = r.store.openRows();
    assert.ok(open.length > 0);
    assert.ok(open.every((row) => row.flags & SEABED_FLAG.DEPTH_DERIVED));
    r.store.close();
});
