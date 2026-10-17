import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiaryRelayOutbox } from './diaryRelayOutbox.js';
import { readCabinOperatorBinding } from './cabin/operatorBinding.js';
import { cabinOwnerBinding } from './cabin/access.js';

// Genuine production SQLite adapter, intended for the isolated Linux Node22 job.
// A machine without the native binding must report that limitation rather than skip this case.
test('actual outbox configuration fences no-op, A→B→A, internet changes, rejection and close without leaking a bearer', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-authority-'));
    const outbox = new DiaryRelayOutbox(directory, {
        trustedSupabaseOrigin: 'https://synthetic.supabase.co',
        retryIntervalMs: 0,
    });
    t.after(() => {
        outbox.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const relay = {
        url: 'https://synthetic.supabase.co/functions/v1/diary-relay',
        relayId: 'synthetic-relay-0001',
        token: 'a'.repeat(64),
        ownerId: '11111111-1111-4111-8111-111111111111',
    };
    assert.equal(outbox.readAuthorityGeneration(), 0);
    assert.equal(outbox.readOwnerGeneration(), 0);
    outbox.configure({ ...relay, allowInternet: false });
    const a = outbox.readAuthorityGeneration()!;
    assert.equal(a, 1);
    assert.equal(outbox.readOwnerGeneration(), 1);
    assert.equal(readCabinOperatorBinding(directory), cabinOwnerBinding(relay));
    outbox.configure({ ...relay, allowInternet: false });
    assert.equal(outbox.readAuthorityGeneration(), a);
    outbox.configure({ ...relay, ownerId: '22222222-2222-4222-8222-222222222222' });
    assert.notEqual(readCabinOperatorBinding(directory), cabinOwnerBinding(relay));
    assert.equal(outbox.readAuthorityGeneration(), a + 1);
    outbox.configure(relay);
    assert.equal(outbox.readAuthorityGeneration(), a + 2);
    outbox.configure({ allowInternet: true });
    assert.equal(outbox.readAuthorityGeneration(), a + 3);
    outbox.configure({ allowInternet: true });
    assert.equal(outbox.readAuthorityGeneration(), a + 3);
    outbox.configure({ allowInternet: false });
    assert.equal(outbox.readAuthorityGeneration(), a + 4);
    assert.equal(outbox.readOwnerGeneration(), 3);
    assert.equal(readCabinOperatorBinding(directory), cabinOwnerBinding(relay));
    assert.throws(() => Reflect.apply(outbox.configure, outbox, [{ allowInternet: 'invalid' }]));
    assert.equal(outbox.readAuthorityGeneration(), a + 4);
    assert.ok(!JSON.stringify(outbox.getConfiguration()).includes(relay.token));
    outbox.close();
    assert.equal(outbox.readAuthorityGeneration(), null);
});
