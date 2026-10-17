import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCabinRuntime } from './runtime.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rotateCabinCode } from './codeFile.js';
test('display defaults off and invalid optional ports refuse without interrupting the main watch server', () => {
    let reads = 0;
    const base = {
        host: '127.0.0.1',
        port: 3002,
        mainPort: 3001,
        cacheDirectory: '.',
        assets: '.',
        context: () => null,
        binding: () => null,
        read: async () => {
            reads++;
            throw Error('No source should open');
        },
    };
    assert.equal(startCabinRuntime({ ...base, enabled: false }), null);
    for (const port of [0, NaN, 3001, 65536]) assert.equal(startCabinRuntime({ ...base, enabled: true, port }), null);
    assert.equal(reads, 0);
});
test('actual enabled loopback listener invalidates a pre-boot code and admits only a newly issued current-owner code', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-runtime-')),
        assets = path.join(directory, 'assets'),
        file = path.join(directory, 'cabin', 'access.json'),
        binding = 'c'.repeat(64);
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, 'index.html'), '<title>Cabin fixture</title>');
    const prior = rotateCabinCode(file, binding);
    const reserve = http.createServer();
    reserve.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => reserve.once('listening', resolve));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const runtime = startCabinRuntime({
        enabled: true,
        host: '127.0.0.1',
        port,
        mainPort: 3001,
        cacheDirectory: directory,
        assets,
        context: () => 'ownerA:1',
        binding: () => binding,
        read: async () => ({ available: false, telemetry: null, ais: [], served_at: new Date().toISOString() }),
    });
    assert.ok(runtime);
    t.after(async () => {
        const close = new Promise<void>((resolve) => runtime.server.once('close', resolve));
        runtime.close();
        await close;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => runtime.server.once('listening', resolve));
    assert.equal(fs.existsSync(file), false);
    const base = `http://127.0.0.1:${port}`;
    const pair = (code: string) =>
        fetch(base + '/api/cabin/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
    assert.equal((await pair(prior.code)).status, 401);
    const current = rotateCabinCode(file, binding);
    assert.equal((await pair(current.code)).status, 200);
    assert.equal((await fetch(base + '/api/ais-watch', { method: 'POST' })).status, 404);
});
