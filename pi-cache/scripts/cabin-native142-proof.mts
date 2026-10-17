import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DiaryRelayOutbox } from '../src/diaryRelayOutbox.js';
import { CabinAccess, cabinOwnerBinding } from '../src/cabin/access.js';
import { readCabinCode } from '../src/cabin/codeFile.js';
import { readCabinOperatorBinding } from '../src/cabin/operatorBinding.js';

// This is a disposable Linux proof, never an installer or a command for a boat Pi.
assert.equal(process.env.THALASSA_DISPOSABLE_CABIN_TEST, '1');
assert.equal(process.platform, 'linux');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin142-native-'));
const outbox = new DiaryRelayOutbox(directory, {
    trustedSupabaseOrigin: 'https://synthetic.supabase.co',
    retryIntervalMs: 0,
});
const relay = {
    url: 'https://synthetic.supabase.co/functions/v1/diary-relay',
    relayId: 'synthetic-relay-0001',
    token: 'a'.repeat(64),
    ownerId: '11111111-1111-4111-8111-111111111111',
};
let checks = 0;
function check(value: unknown, message: string): asserts value {
    assert.ok(value, message);
    checks++;
}
const codeFile = path.join(directory, 'cabin', 'access.json');
function issue(): string {
    const before = JSON.stringify(outbox.getConfiguration());
    const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../dist/cabin/accessCode.js', import.meta.url)), '--rotate'],
        {
            cwd: directory,
            env: { PATH: process.env.PATH, CACHE_DIR: directory },
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 2_048,
        },
    );
    // Neither a printed one-time code nor captured stderr is included in evidence.
    check(result.status === 0 && !result.error, 'Compiled operator command exited successfully');
    const match = /^Cabin display code: (\d{8})\nValid until /m.exec(result.stdout);
    check(!!match, 'Compiled operator command issued exactly one bounded code');
    check(JSON.stringify(outbox.getConfiguration()) === before, 'Read-only issuer left pairing configuration intact');
    return match[1];
}
try {
    outbox.configure({ ...relay, allowInternet: false });
    check(readCabinOperatorBinding(directory) === cabinOwnerBinding(relay), 'Real SQLite pairing binds the issuer');
    const codeA = issue();
    check((fs.statSync(codeFile).mode & 0o777) === 0o600, 'Actual issued code file is private');
    check((fs.statSync(path.dirname(codeFile)).mode & 0o777) === 0o700, 'Actual code directory is private');
    check(!fs.readFileSync(codeFile, 'utf8').includes(codeA), 'Stored record contains no plaintext code');
    const access = new CabinAccess({
        code: () => readCabinCode(codeFile),
        context: () => String(outbox.readOwnerGeneration()),
        binding: () => readCabinOperatorBinding(directory),
    });
    const viewerA = access.pair(codeA, 'loopback');
    check(!!viewerA, 'Actual compiled CLI code pairs a read-only viewer');
    const leaseA = access.lease(viewerA.token);
    check(!!leaseA, 'Current owner viewer has a read lease');
    check(leaseA.isCurrent(), 'Current owner viewer lease is admitted');
    outbox.configure({ allowInternet: true });
    outbox.configure({ allowInternet: false });
    check(leaseA.isCurrent(), 'Internet permission does not retire local cabin ownership');
    outbox.configure({ ownerId: '22222222-2222-4222-8222-222222222222' });
    check(!leaseA.isCurrent(), 'A to B retires an already captured viewer');
    check(access.pair(codeA, 'next-owner') === null, 'An old operator code cannot pair the next owner');
    outbox.configure(relay);
    check(access.pair(codeA, 'returned-owner') === null, 'A to B to A cannot revive the old operator code');
    const codeNewA = issue();
    check(!!access.pair(codeNewA, 'fresh-owner'), 'Fresh CLI rotation restores explicitly issued access');
    fs.chmodSync(codeFile, 0o644);
    check(readCabinCode(codeFile) === null, 'Publicly readable code storage is refused');
    check(access.pair(codeNewA, 'bad-permissions') === null, 'Unsafe file permissions cannot mint a viewer');
    access.close();
    process.stdout.write(
        JSON.stringify({ schema: 1, checks, failures: 0, skips: 0, sqlite: 'production', operator: 'compiled' }) + '\n',
    );
} finally {
    outbox.close();
    fs.rmSync(directory, { recursive: true, force: true });
}
