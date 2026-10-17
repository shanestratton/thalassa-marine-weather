import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateCabinCode, readCabinCode, invalidateCabinCode } from './codeFile.js';
import { CabinAccess } from './access.js';
test('actual local code file stores only a hash, rotation retires viewers and corrupt/missing/oversized data holds', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-code-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'private', 'access.json'),
        now = 1_792_000_000_000;
    const binding = 'c'.repeat(64),
        first = rotateCabinCode(file, binding, now);
    assert.match(first.code, /^\d{8}$/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(first.code));
    const access = new CabinAccess({
        binding: () => binding,
        code: () => readCabinCode(file, now),
        context: () => 'synthetic:1',
        now: () => now,
    });
    const token = access.pair(first.code, 'peer')!.token,
        lease = access.lease(token)!;
    rotateCabinCode(file, binding, now);
    assert.equal(lease.isCurrent(), false);
    for (const bytes of ['{', ' '.repeat(513), '{}']) {
        fs.writeFileSync(file, bytes);
        assert.equal(readCabinCode(file, now), null);
    }
    fs.rmSync(file);
    assert.equal(readCabinCode(file, now), null);
    rotateCabinCode(file, binding, now);
    invalidateCabinCode(file);
    assert.equal(fs.existsSync(file), false);
    invalidateCabinCode(file);
});
