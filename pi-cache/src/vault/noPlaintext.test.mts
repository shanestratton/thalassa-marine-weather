/**
 * The licence test (127-C-d, o-charts 2026-10-10: "Storing unencrypted data on
 * any medium, and especially in the cloud, is strictly prohibited").
 *
 * A full round through BOTH processes' code, in one test process so one spy
 * sees everything: the vault indexes two fictional delivered sets through the
 * real oexserverd client and FIFOs (a fake daemon, fakeOexserverd.mjs), a
 * phone enrols over the front door, lists and pulls every cell, deletes one,
 * and a new delivery is rescanned and pulled. Every cell carries a unique
 * marker in an OBJNAM and in a sounding.
 *
 * Every fs write API is spied (writeFile, appendFile, createWriteStream,
 * copyFile, cp, rename targets, write-opens and FileHandle writes); FIFOs are
 * exempt (mkfifo is the protocol, and a FIFO stores nothing). Every written
 * path must be vault-index.json, removed.json or enc-devices.json (or an
 * atomic temp renamed onto one), and no written byte may contain a marker.
 * Afterwards a recursive scan of the store, CACHE_DIR and TMPDIR finds no
 * marker. Then the same checks are shown to fail on a run whose decrypt writes
 * the decoded bytes to TMPDIR.
 */
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildSenc, openFixture, writeFixtureCatalogue, writeFixtureSet, type FixtureCell } from './fakeOexserverd.mjs';
// Every module is loaded before a spy goes on, so the test runner's own
// transpile cache (tsx writes compiled modules to TMPDIR) is not counted.
import { loadOrCreateIdentity } from '../identity.js';
import { OexDecoder } from './decoder.js';
import { VaultService } from './vaultService.js';
import { createVaultHttpServer, listenOnSocket } from './vaultServer.js';
import { VAULT_INDEX_ENTRY_KEYS } from './vaultIndex.js';
import { createVaultClient } from '../vaultClient.js';
import { EncDeviceStore } from '../encDevices.js';
import { createEncRoutes } from '../routes/enc.js';

const require = createRequire(import.meta.url);
const fsCjs = require('node:fs') as typeof import('node:fs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
// enc-devices.json.lock holds the writer's pid: the device list's cross-process lock (no chart data).
const ALLOWED = new Set(['vault-index.json', 'removed.json', 'enc-devices.json', 'enc-devices.json.lock']);
const box = { s: 50.7, w: -1.4, n: 50.8, e: -1.2 };

interface Write {
    api: string;
    target: string;
    data?: Buffer;
}

/** Spy on every fs write API in this process. FIFOs are exempt. */
function spyOnWrites() {
    const writes: Write[] = [];
    let recording = true;
    const fdPaths = new Map<number, string>();
    const isFifo = (p: string) => {
        try {
            return fsCjs.lstatSync(p).isFIFO();
        } catch {
            return false;
        }
    };
    const bytes = (value: unknown): Buffer | undefined =>
        typeof value === 'string'
            ? Buffer.from(value)
            : Buffer.isBuffer(value)
              ? value
              : value instanceof Uint8Array
                ? Buffer.from(value)
                : undefined;
    const record = (api: string, target: unknown, data?: unknown) => {
        if (!recording || (typeof target !== 'string' && !(target instanceof URL))) return;
        const p = target instanceof URL ? fileURLToPath(target) : target;
        if (isFifo(p)) return;
        writes.push({ api, target: path.resolve(p), data: bytes(data) });
    };
    const writeFlags = (flags: unknown) =>
        typeof flags === 'string'
            ? /[wa+]/.test(flags)
            : typeof flags === 'number' &&
              (flags & (fsCjs.constants.O_WRONLY | fsCjs.constants.O_RDWR | fsCjs.constants.O_APPEND)) !== 0;
    const restore: (() => void)[] = [];
    const patch = <T extends object>(owner: T, name: keyof T & string, wrap: (original: never) => unknown) => {
        const original = owner[name];
        (owner as Record<string, unknown>)[name] = wrap(original as never);
        restore.push(() => {
            (owner as Record<string, unknown>)[name] = original;
        });
    };
    type Fn = (...args: unknown[]) => unknown;
    for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync'] as const)
        patch(fsCjs, name, (o: Fn) => (file: unknown, data: unknown, ...rest: unknown[]) => {
            record(name, file, data);
            return o(file, data, ...rest);
        });
    for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync'] as const)
        patch(fsCjs, name, (o: Fn) => (from: unknown, to: unknown, ...rest: unknown[]) => {
            record(name, to);
            return o(from, to, ...rest);
        });
    patch(fsCjs, 'createWriteStream', (o: Fn) => (file: unknown, ...rest: unknown[]) => {
        record('createWriteStream', file);
        return o(file, ...rest);
    });
    patch(fsCjs, 'openSync', (o: Fn) => (file: unknown, flags: unknown, ...rest: unknown[]) => {
        const fd = o(file, flags, ...rest) as number;
        if (writeFlags(flags)) {
            record('openSync', file);
            if (typeof file === 'string') fdPaths.set(fd, file);
        }
        return fd;
    });
    patch(fsCjs, 'writeSync', (o: Fn) => (fd: unknown, data: unknown, ...rest: unknown[]) => {
        const p = fdPaths.get(fd as number);
        if (p) record('writeSync', p, data);
        return o(fd, data, ...rest);
    });
    const promises = fsCjs.promises;
    for (const name of ['writeFile', 'appendFile'] as const)
        patch(promises, name, (o: Fn) => (file: unknown, data: unknown, ...rest: unknown[]) => {
            record(`promises.${name}`, file, data);
            return o(file, data, ...rest);
        });
    for (const name of ['copyFile', 'cp', 'rename'] as const)
        patch(promises, name, (o: Fn) => (from: unknown, to: unknown, ...rest: unknown[]) => {
            record(`promises.${name}`, to);
            return o(from, to, ...rest);
        });
    patch(promises, 'open', (o: Fn) => async (file: unknown, flags: unknown, ...rest: unknown[]) => {
        const handle = (await o(file, flags, ...rest)) as import('node:fs/promises').FileHandle;
        if (writeFlags(flags ?? 'r')) {
            record('promises.open', file);
            const write = handle.write.bind(handle) as Fn;
            (handle as unknown as Record<string, unknown>).write = (data: unknown, ...more: unknown[]) => {
                record('handle.write', file, data);
                return write(data, ...more);
            };
            const writeFile = handle.writeFile.bind(handle) as Fn;
            (handle as unknown as Record<string, unknown>).writeFile = (data: unknown, ...more: unknown[]) => {
                record('handle.writeFile', file, data);
                return writeFile(data, ...more);
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    return {
        writes,
        pause: () => {
            recording = false;
        },
        resume: () => {
            recording = true;
        },
        stop() {
            recording = false;
            for (const undo of restore.reverse()) undo();
            syncBuiltinESMExports();
        },
    };
}

/** What a run wrote that the licence forbids. */
export function licenceProblems(writes: Write[], markers: string[]): string[] {
    const problems: string[] = [];
    const renamedOnto = new Map<string, string>();
    for (const w of writes) if (w.api.includes('rename')) renamedOnto.set(w.target, w.target);
    for (const w of writes) {
        const base = path.basename(w.target);
        const tempOf = /^\.(.+)\.[0-9a-f-]{36}\.tmp$/.exec(base)?.[1];
        if (!ALLOWED.has(base) && !(tempOf && ALLOWED.has(tempOf))) problems.push(`${w.api} wrote ${w.target}`);
        if (w.data)
            for (const m of markers) if (w.data.includes(m)) problems.push(`${w.api} wrote a marker to ${w.target}`);
    }
    return problems;
}

/** Every regular file under these roots that holds a marker. */
async function markersOnDisk(roots: string[], markers: string[]): Promise<string[]> {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const text = await fs.readFile(full);
                for (const m of markers) if (text.includes(m)) hits.push(`${full}: ${m}`);
            }
        }
    };
    for (const root of roots) await walk(root);
    return hits;
}

async function world(t: TestContext, label: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `vault-licence-${label}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dirs = {
        charts: path.join(root, 'home', 'Charts'),
        store: path.join(root, 'opt', 'enc-charts'),
        cache: path.join(root, 'opt', 'cache'),
        tmp: path.join(root, 'tmp'),
        run: path.join(root, 'run'),
        identity: path.join(root, 'opt', 'identity'),
        reference: path.join(root, 'opt', 'reference'),
    };
    for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
    const tmpBefore = process.env.TMPDIR;
    t.after(() => {
        if (tmpBefore === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmpBefore;
    });
    writeFixtureCatalogue(dirs.reference);
    const run = randomUUID().slice(0, 8);
    const markers: string[] = [];
    const spec = (n: number, file: string, native: string, edition = 1): FixtureCell => {
        const objnam = `KESTREL-MARK-${run}-${n}`;
        const depth = 4000 + n + 0.5;
        markers.push(objnam, `${depth}`);
        return { file, sourceCellId: native, edition, issued: '20260920', extent: box, objnam, depth };
    };
    return { root, dirs, markers, spec };
}

test('no decrypted chart byte reaches any disk: index, serve, delete and rescan', async (t) => {
    const w = await world(t, 'clean');
    writeFixtureSet(path.join(w.dirs.charts, 'oeuSENC-ZZ-2026-1-0'), {
        cells: [w.spec(1, 'OC-99-ZZ0001', 'ZZ5KESTR'), w.spec(2, 'OC-99-ZZ0002', 'ZZ5KESTB')],
    });
    // The daemon is a separate process, as on the Pi: the spy watches this one.
    const launcher = path.join(w.root, 'oexserverd');
    await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fakeOexserverd.mjs')}"\n`, {
        mode: 0o755,
    });
    const commandPipe = path.join(w.dirs.run, 'OCPN_PIPEX');
    process.env.VAULT_OEX_COMMAND_PIPE = commandPipe;
    process.env.TMPDIR = w.dirs.tmp;
    const identity = loadOrCreateIdentity(w.dirs.identity, 'Kestrel');

    const spy = spyOnWrites();
    t.after(() => spy.stop());

    const decoder = new OexDecoder({
        binaryPath: launcher,
        commandPipe,
        readTimeoutMs: 10_000,
        startupTimeoutMs: 10_000,
    });
    const vault = new VaultService({
        stateDir: path.join(w.dirs.store, 'vault'),
        roots: [w.dirs.charts, path.join(w.dirs.store, 'sources')],
        referenceDir: w.dirs.reference,
        lruBytes: 1024 * 1024,
        initialWatching: false,
        decrypt: (file, key) => decoder.decrypt(file, key),
        onStop: () => decoder.stop(),
    });
    const socket = path.join(w.dirs.run, 'vault.sock');
    const vaultServer = createVaultHttpServer(vault);
    await listenOnSocket(vaultServer, socket);
    t.after(async () => {
        vaultServer.close();
        await vault.stop();
    });
    await vault.start();
    await vault.whenReady();

    const devices = new EncDeviceStore(path.join(w.dirs.cache, 'enc-devices.json'));
    const app = express();
    app.use(express.json());
    app.use(
        '/api/enc',
        createEncRoutes(identity, {
            vault: createVaultClient(socket),
            devices,
            chartStoreDir: w.dirs.store,
            peerOf: () => '192.168.1.23',
            lanView: () => ({
                interfaces: {
                    eth0: [
                        {
                            address: '192.168.1.180',
                            netmask: '255.255.255.0',
                            family: 'IPv4',
                            internal: false,
                            mac: '',
                            cidr: '192.168.1.180/24',
                        },
                    ],
                },
                gateways: ['192.168.1.1'],
            }),
        }),
    );
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enc`;

    const { code } = await devices.mintCode();
    const enrol = await fetch(`${base}/devices/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label: 'iPhone' }),
    });
    assert.equal(enrol.status, 200);
    const { token } = (await enrol.json()) as { token: string };
    const headers = { 'X-Thalassa-Chart-Device': token };

    const listed = (await (await fetch(`${base}/installed`, { headers })).json()) as { cells: { cellId: string }[] };
    assert.deepEqual(listed.cells.map((c) => c.cellId).sort(), ['OC-99-ZZ0001', 'OC-99-ZZ0002']);
    for (const { cellId } of listed.cells) {
        const res = await fetch(`${base}/installed/${cellId}/data`, { headers });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(
            w.markers.some((m) => text.includes(m)),
            'the phone gets the chart, in memory',
        );
    }
    assert.equal((await fetch(`${base}/installed/OC-99-ZZ0002`, { method: 'DELETE', headers })).status, 200);

    spy.pause();
    writeFixtureSet(path.join(w.dirs.store, 'sources', `${'b'.repeat(64)}-${randomUUID()}`, 'oeuSENC-ZZ-2026-1-1'), {
        cells: [w.spec(3, 'OC-99-ZZ0003', 'ZZ5KESTC')],
    });
    spy.resume();
    const rescanned = await createVaultClient(socket).rescan(['OC-99-ZZ0003']);
    assert.deepEqual(rescanned.summary, { new: 1, updated: 0, unchanged: 0, total: 1 });
    assert.equal((await fetch(`${base}/installed/OC-99-ZZ0003/data`, { headers })).status, 200);
    spy.stop();

    assert.ok(spy.writes.length > 0, 'the spy saw the allowed writes');
    assert.deepEqual(licenceProblems(spy.writes, w.markers), []);
    const index = JSON.parse(await fs.readFile(path.join(w.dirs.store, 'vault', 'vault-index.json'), 'utf8'));
    for (const entry of index.files) assert.deepEqual(Object.keys(entry).sort(), [...VAULT_INDEX_ENTRY_KEYS].sort());
    assert.deepEqual(await markersOnDisk([w.dirs.store, w.dirs.cache, w.dirs.tmp], w.markers), []);
});

test('proven to fail: a decrypt that writes the decoded bytes to TMPDIR turns the checks red', async (t) => {
    const w = await world(t, 'leaky');
    writeFixtureSet(path.join(w.dirs.charts, 'set'), { cells: [w.spec(1, 'OC-99-ZZ0001', 'ZZ5KESTR')] });
    process.env.TMPDIR = w.dirs.tmp;
    const spy = spyOnWrites();
    t.after(() => spy.stop());
    const vault = new VaultService({
        stateDir: path.join(w.dirs.store, 'vault'),
        roots: [w.dirs.charts],
        referenceDir: w.dirs.reference,
        lruBytes: 1024 * 1024,
        initialWatching: false,
        decrypt: async (file, key) => {
            const senc = buildSenc(openFixture(await fs.readFile(file), key)!);
            // The test-only leak: what any "cache it on disk" shortcut would do.
            await fs.writeFile(path.join(os.tmpdir(), 'decoded.bin'), senc);
            return senc;
        },
    });
    t.after(() => vault.stop());
    await vault.start();
    await vault.whenReady();
    await vault.cell('OC-99-ZZ0001');
    spy.stop();
    const problems = licenceProblems(spy.writes, w.markers);
    assert.ok(
        problems.some((p) => p.includes('decoded.bin')),
        problems.join('\n'),
    );
    assert.ok(problems.some((p) => p.includes('marker')));
    assert.ok((await markersOnDisk([w.dirs.tmp], w.markers)).length > 0);
});
