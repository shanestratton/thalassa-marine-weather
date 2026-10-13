/**
 * thalassa-cache's link to the chart vault (127-C-d decisions 1, 7 and 11).
 *
 * The vault decodes on one thread, so a large cell blocks its event loop for
 * seconds. /api/admin/status is the app's Pi health probe (2 s), and it lives
 * in the watch's process: it must answer from memory, never wait on the
 * vault. And a vault that restarted knows nothing of the watch until told,
 * counting one as on (no index pass, no prewarm): it is told within a status
 * check, not at the next change of watch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVaultClient, startVaultLink } from './vaultClient.js';
import type { VaultStatusWire } from './vault/protocol.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const statusWire = (watching: boolean | null): VaultStatusWire => ({
    v: 1,
    state: 'ready',
    cells: 3,
    opened: 0,
    toOpen: 0,
    lruBytes: 0,
    lruCells: 0,
    waiting: 0,
    watching,
    rescanPending: false,
    decoder: 'up',
    skippedSets: [],
});

async function socketPath(t: TestContext): Promise<string> {
    // A unix socket path has a length limit (104 bytes on macOS): a short dir.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'v.sock');
}

/** A vault stand-in: answers /v1/status as `state()` says (or hangs), and records each hint. */
async function fakeVault(t: TestContext, state: { watching: boolean | null; hang: boolean }) {
    const sock = await socketPath(t);
    const hints: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        if (state.hang) return; // accepted, never answered: a loop blocked by a decode
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            if (req.url === '/v1/status') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(statusWire(state.watching)));
            }
            if (req.url === '/v1/hint') {
                const h = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
                hints.push(h);
                if (typeof h.watching === 'boolean') state.watching = h.watching;
                res.writeHead(204);
                return res.end();
            }
            res.writeHead(404);
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return { sock, hints };
}

const until = async (predicate: () => boolean, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

test('a vault socket that accepts and never answers: the status is read from memory at once', async (t) => {
    const sock = await socketPath(t);
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => sockets.push(s)); // never writes a byte
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    t.after(() => {
        for (const s of sockets) s.destroy();
        server.close();
    });
    const link = startVaultLink({
        client: createVaultClient(sock),
        watching: () => false,
        fix: async () => null,
        statusEveryMs: 20,
    });
    t.after(() => link.stop());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = performance.now();
    const view = link.lastStatus();
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `answered in ${ms.toFixed(1)} ms`);
    assert.deepEqual(view, { status: null, ageMs: null }, 'never answered: unreachable, not a wait');
});

test('a vault whose loop blocks after it answered: the last status, with its age, until it is stale', async (t) => {
    const state = { watching: false as boolean | null, hang: false };
    const v = await fakeVault(t, state);
    let clock = 1_000_000;
    const link = startVaultLink({
        client: createVaultClient(v.sock),
        watching: () => false,
        fix: async () => null,
        statusEveryMs: 20,
        staleMs: 30_000,
        now: () => clock,
    });
    t.after(() => link.stop());
    await until(() => link.lastStatus().status !== null);
    state.hang = true;
    clock += 4_000;
    const t0 = performance.now();
    const view = link.lastStatus();
    assert.ok(performance.now() - t0 < 50);
    assert.equal(view.status?.state, 'ready', 'a decode in the vault does not make it unreachable');
    assert.equal(view.ageMs, 4_000);
    clock += 30_000;
    assert.deepEqual(link.lastStatus(), { status: null, ageMs: 34_000 }, 'past statusStaleMs it counts as no answer');
});

test('a restarted vault (watching null) hears the watch state, and the fix, within one status check', async (t) => {
    const state = { watching: false as boolean | null, hang: false };
    const v = await fakeVault(t, state);
    const link = startVaultLink({
        client: createVaultClient(v.sock),
        watching: () => false,
        fix: async () => ({ lat: -36.84, lon: 174.76 }),
        statusEveryMs: 20,
        // The watch check and the fix are far off: only the status check can tell it.
        checkMs: 60_000,
        everyMs: 60 * 60_000,
    });
    t.after(() => link.stop());
    await until(() => v.hints.length >= 1);
    const first = v.hints.length;
    // systemd restarts the vault (a MemoryMax kill, or a re-plugged dongle).
    state.watching = null;
    await until(() => v.hints.length > first, 1_000);
    assert.deepEqual(v.hints.at(-1), { watching: false, lat: -36.84, lon: 174.76 });
    assert.equal(state.watching, false, 'the vault knows no watch is on: its index pass and prewarm may run');
});

test('the watch state goes on every check, changed or not', async (t) => {
    const state = { watching: false as boolean | null, hang: false };
    const v = await fakeVault(t, state);
    const link = startVaultLink({
        client: createVaultClient(v.sock),
        watching: () => false,
        fix: async () => null,
        statusEveryMs: 60_000,
        checkMs: 20,
    });
    t.after(() => link.stop());
    await until(() => v.hints.length >= 4);
    assert.ok(v.hints.every((h) => h.watching === false));
});

test('/api/admin/status (server.ts) never waits on the vault: it reads the link, synchronously', () => {
    const server = readFileSync(path.join(SRC, 'server.ts'), 'utf8');
    const start = server.indexOf("app.get('/api/admin/status'");
    assert.ok(start > 0);
    const handler = server.slice(start, server.indexOf('\n});', start));
    assert.match(handler, /requireAppApi, \(_req, res\) =>/, 'a synchronous handler');
    assert.doesNotMatch(handler, /\bawait\b|chartVault\.status\(/, 'no call to the vault on the probe path');
    assert.match(handler, /vaultLink\?\.lastStatus\(\)/);
    assert.match(handler, /anchorWatch: anchorWatch\.describe\(\)/);
    assert.match(handler, /aisWatch: aisWatch\.describe\(\)/);
    assert.match(server, /vaultLink = startVaultLink\(/);
});
