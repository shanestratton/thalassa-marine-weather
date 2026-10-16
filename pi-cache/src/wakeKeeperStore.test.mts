import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WakeKeeperStore } from './wakeKeeper/store.js';
import { defaultWakeRules, wakeRulesCanonical } from './wakeRule/wakeRule.js';
import {
    parseWakeConfigurationRequest,
    wakeFeedId,
    wakeHash,
    wakeEnrollmentRevision,
    wakePairingId,
    WakeKeeperError,
    type WakeBinding,
} from './wakeKeeper/contract.js';

const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002',
    device = '00000000-0000-4000-8000-000000000003';
const now = Date.parse('2026-10-16T00:00:00Z');
const binding: WakeBinding = {
    ownerId: owner,
    piDeviceId: pi,
    pairingId: wakePairingId(owner, pi, 'fictional-relay-identity'),
    deviceId: device,
    enrollmentRevision: wakeEnrollmentRevision({ id: device, enrolledAt: new Date(now - 60000).toISOString() }),
    feedId: wakeFeedId(pi, 'urn:mrn:imo:mmsi:000000001')!,
};
function request(expectedRevision: string | null = null, selected = binding) {
    const rules = defaultWakeRules(),
        draftM = 2;
    return {
        schema: 1 as const,
        expectedRevision,
        binding: selected,
        draftM,
        rules,
        rulesDigest: wakeHash(wakeRulesCanonical(rules, draftM)),
    };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-wake-store-'));
    t.after(async () => {
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return {
        directory,
        store: new WakeKeeperStore(directory),
        file: path.join(directory, 'wake-keeper', 'configuration.json'),
    };
}
const current = async () => true;
test('all presets stay OFF and physically unselected through strict normalization and atomic private persistence', async (t) => {
    const f = await fixture(t);
    assert.equal(await f.store.load(), null);
    const config = await f.store.configure(request(), current, now);
    assert.equal(
        config.rules.every((r) => r.enabled === false && r.selection === null),
        true,
    );
    assert.deepEqual(await f.store.load(), config);
    assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['configuration.json']);
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});
test('fixed canonical config rejects extra/path fields, digest tampering, duplicate presets and unqualified enabled rules', () => {
    for (const mutate of [
        (r: Record<string, unknown>) => {
            r.url = 'https://unexpected.example';
        },
        (r: Record<string, unknown>) => {
            r.rulesDigest = '0'.repeat(64);
        },
        (r: Record<string, unknown>) => {
            r.draftM = 0;
        },
        (r: Record<string, unknown>) => {
            r.rules = [...defaultWakeRules().slice(1), defaultWakeRules()[1]];
        },
        (r: Record<string, unknown>) => {
            const rules = defaultWakeRules();
            rules[0].enabled = true;
            r.rules = rules;
        },
        (r: Record<string, unknown>) => {
            const rules = defaultWakeRules();
            Object.assign(rules[0], { path: 'steering.autopilot.state' });
            r.rules = rules;
        },
    ]) {
        const r: Record<string, unknown> = request();
        mutate(r);
        assert.throws(() => parseWakeConfigurationRequest(r), WakeKeeperError);
    }
    assert.equal(JSON.stringify(binding).includes('urn:mrn'), false);
});
test('two real store instances racing one compare-and-swap revision permit exactly one configuration', async (t) => {
    const f = await fixture(t),
        other = new WakeKeeperStore(f.directory);
    const result = await Promise.allSettled([
        f.store.configure(request(), current, now),
        other.configure(request(), current, now),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failed.reason.code, 'conflict');
    const kept = await f.store.load();
    assert.ok(kept?.revision);
    await assert.rejects(
        f.store.configure(request(), current, now),
        (error: unknown) => error instanceof WakeKeeperError && error.code === 'conflict',
    );
});
test('an uncertain crashed-writer lock is never deleted by age/PID, preserving another writer from reclamation races', async (t) => {
    const f = await fixture(t);
    await f.store.load();
    const lock = path.join(path.dirname(f.file), 'configuration.lock');
    const bytes = JSON.stringify({ pid: 2147483647, nonce: 'fictional-crashed-writer' });
    await fs.writeFile(lock, bytes, { mode: 0o600 });
    await assert.rejects(
        f.store.configure(request(), current, now),
        (error: unknown) => error instanceof WakeKeeperError && error.code === 'busy',
    );
    assert.equal(await fs.readFile(lock, 'utf8'), bytes);
    assert.equal(await f.store.load(), null);
});
test('binding/enrollment changes before or after atomic rename cannot commit a changed profile', async (t) => {
    const f = await fixture(t),
        old = await f.store.configure(request(), current, now);
    for (const denyOn of [1, 2, 3]) {
        let checks = 0;
        await assert.rejects(
            f.store.configure(request(old.revision), async () => ++checks !== denyOn, now + 1),
            (error: unknown) => error instanceof WakeKeeperError && error.code === 'binding',
        );
        assert.deepEqual(await f.store.load(), old);
    }
});
test('a newly trusted owner/pair starts a separate default-OFF configuration and cannot see/overwrite by the old revision', async (t) => {
    const f = await fixture(t),
        old = await f.store.configure(request(), current, now);
    const ownerId = '00000000-0000-4000-8000-000000000004';
    const nextBinding = { ...binding, ownerId, pairingId: wakePairingId(ownerId, pi, 'different-fictional-relay') };
    await assert.rejects(
        f.store.configure(request(old.revision, nextBinding), current, now + 1),
        (error: unknown) => error instanceof WakeKeeperError && error.code === 'conflict',
    );
    const next = await f.store.configure(request(null, nextBinding), current, now + 1);
    assert.equal(next.binding.ownerId, ownerId);
    assert.equal(
        next.rules.every((r) => !r.enabled),
        true,
    );
    await assert.rejects(f.store.configure(request(old.revision), async () => false, now + 2));
    assert.deepEqual(await f.store.load(), next);
});
test('explicit clear is revision-bound and can roll back if the trusted scope changes before completion', async (t) => {
    const f = await fixture(t),
        old = await f.store.configure(request(), current, now);
    await assert.rejects(
        f.store.clear(binding, null, current),
        (error: unknown) => error instanceof WakeKeeperError && error.code === 'conflict',
    );
    let checks = 0;
    await assert.rejects(f.store.clear(binding, old.revision, async () => ++checks !== 3));
    assert.deepEqual(await f.store.load(), old);
    await f.store.clear(binding, old.revision, current);
    assert.equal(await f.store.load(), null);
});
test('corrupt/oversized stored bytes fail closed and remain available for review rather than being replaced silently', async (t) => {
    const f = await fixture(t);
    await f.store.load();
    for (const data of ['{broken', ' '.repeat(16385)]) {
        await fs.writeFile(f.file, data, { mode: 0o600 });
        await assert.rejects(
            f.store.load(),
            (error: unknown) => error instanceof WakeKeeperError && error.code === 'unavailable',
        );
        await assert.rejects(f.store.configure(request(), current, now));
        assert.equal(await fs.readFile(f.file, 'utf8'), data);
    }
});
test('a symlinked configuration cannot redirect reads or writes outside the private store', async (t) => {
    const f = await fixture(t);
    await f.store.load();
    const outside = path.join(f.directory, 'other-record.json');
    await fs.writeFile(outside, 'untouched', { mode: 0o600 });
    try {
        await fs.symlink(outside, f.file);
    } catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
            t.skip('Windows denied symlink creation; Linux security test remains required');
            return;
        }
        throw error;
    }
    await assert.rejects(f.store.load());
    await assert.rejects(f.store.configure(request(), current, now));
    assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});
