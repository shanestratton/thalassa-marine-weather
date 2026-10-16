import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyBundle, verifyArchiveInventory, assertWatchIdle, sha256, inside } from './update5.mjs';
const members = ['manifest.json', 'source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs'];
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update5-test-'));
    const payload = Buffer.from('A fictional source archive; no live Pi data');
    const manifest = {
        schema: 1,
        update: 5,
        appBuild: 133,
        sourceCommit: 'a'.repeat(40),
        guardVersion: 1,
        payloadSha256: sha256(payload),
        sourceFiles: ['pi-cache/src/server.ts', 'pi-cache/package.json'],
    };
    fs.writeFileSync(path.join(dir, 'source.tar.gz'), payload);
    for (const [source, dest] of [
        ['install-update5.mjs', 'install.mjs'],
        ['rollback-update5.mjs', 'rollback.mjs'],
        ['update5.mjs', 'update5.mjs'],
    ])
        fs.copyFileSync(new URL(source, import.meta.url), path.join(dir, dest));
    const write = () => {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(
            path.join(dir, 'SHA256SUMS'),
            members.map((name) => `${sha256(fs.readFileSync(path.join(dir, name)))}  ${name}`).join('\n') + '\n',
        );
    };
    write();
    return {
        dir,
        manifest,
        write,
        close: () => {
            inside(os.tmpdir(), dir);
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
test('a complete frozen source bundle verifies and its installer defaults to a read-only plan', () => {
    const f = fixture();
    try {
        assert.equal(verifyBundle(f.dir).sourceCommit, 'a'.repeat(40));
        const before = fs.readdirSync(f.dir).sort();
        const result = JSON.parse(
            execFileSync(process.execPath, [path.join(f.dir, 'install.mjs')], { encoding: 'utf8' }),
        );
        assert.match(result.mode, /PLAN ONLY/);
        assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
    } finally {
        f.close();
    }
});
test('any changed payload or helper byte fails checksum verification', () => {
    for (const name of ['source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs']) {
        const f = fixture();
        try {
            fs.appendFileSync(path.join(f.dir, name), 'changed');
            assert.throws(() => verifyBundle(f.dir), /Checksum mismatch/);
        } finally {
            f.close();
        }
    }
});
test('runtime secrets, chart assets and traversal paths cannot enter the source manifest', () => {
    for (const name of [
        'pi-cache/.env',
        'pi-cache/cache/private.json',
        'pi-cache/identity/key.pem',
        'pi-cache/enc-charts/cell.oesu',
        'pi-cache/../outside',
    ]) {
        const f = fixture();
        try {
            f.manifest.sourceFiles.push(name);
            f.write();
            assert.throws(() => verifyBundle(f.dir), /source boundary/);
        } finally {
            f.close();
        }
    }
});
test('checksum inventory cannot read outside the bundle or omit a helper', () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.dir, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside\n`);
        assert.throws(() => verifyBundle(f.dir), /checksum inventory/);
        assert.throws(() => inside(f.dir, path.join(f.dir, '..', 'outside')), /escapes/);
        assert.throws(() => inside(f.dir, f.dir), /escapes/);
    } finally {
        f.close();
    }
});
test('active, stale, unknown or persisted anchor leases refuse before an update', () => {
    const now = 1800000000000;
    const status = { version: 1, maintenance: false, anchorRunning: false, sessionExpiresAt: null, observedAt: now };
    assert.doesNotThrow(() => assertWatchIdle(status, null, now));
    for (const patch of [
        { version: 0 },
        { anchorRunning: true },
        { anchorRunning: null },
        { observedAt: now - 5001 },
        { sessionExpiresAt: now + 1 },
    ])
        assert.throws(() => assertWatchIdle({ ...status, ...patch }, null, now));
    assert.throws(() => assertWatchIdle(status, { expiresAt: now - 1, sessionExpiresAt: now + 1000 }, now));
    assert.throws(() => assertWatchIdle(status, {}, now));
    assert.doesNotThrow(() => assertWatchIdle(status, { expiresAt: now - 2, sessionExpiresAt: now - 1 }, now));
});
test('archive links, traversal, missing files and duplicate members fail before extraction', () => {
    const files = ['pi-cache/src/server.ts'];
    const entries = [
        'update5-source/',
        'update5-source/pi-cache/',
        'update5-source/pi-cache/src/',
        'update5-source/pi-cache/src/server.ts',
    ];
    assert.doesNotThrow(() => verifyArchiveInventory(entries, ['drwxr-xr-x directory', '-rw-r--r-- file'], files));
    assert.throws(() => verifyArchiveInventory(entries, ['lrwxr-xr-x link'], files));
    assert.throws(() => verifyArchiveInventory([...entries, '../outside'], ['-rw-r--r-- file'], files));
    assert.throws(() => verifyArchiveInventory(entries.slice(0, -1), ['drwxr-xr-x directory'], files));
    assert.throws(() => verifyArchiveInventory([...entries, entries.at(-1)], ['-rw-r--r-- file'], files));
});
