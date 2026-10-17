import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkillOwnerVerifier, type SkillOwnerFetch } from './ownBoatSkill/owner.js';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VESSEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORIGIN = 'https://pcisdplnodrphauixcau.supabase.co';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl';
const NOW = Date.UTC(2026, 9, 17, 6);
const boat = {
    id: VESSEL,
    owner_id: OWNER,
    archived_at: null,
    released_at: null,
    revision: 3,
    name: 'Synthetic vessel',
};
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
function fixture(changes: { user?: unknown; fleet?: unknown } = {}) {
    const calls: Parameters<SkillOwnerFetch>[] = [];
    const fetchImpl: SkillOwnerFetch = async (...args) => {
        calls.push(args);
        return json(
            args[0].endsWith('/auth/v1/user')
                ? (changes.user ?? { id: OWNER })
                : (changes.fleet ?? { vessels: [boat] }),
        );
    };
    return {
        calls,
        fetchImpl,
        verifier: new SkillOwnerVerifier({
            trustedOrigin: ORIGIN,
            anonKey: () => 'synthetic-anon',
            fetchImpl,
            now: () => NOW,
        }),
    };
}
test('private issuance verifies actual auth user and owned-vessel RPC only at startup trusted origin', async () => {
    const { verifier, calls } = fixture();
    assert.deepEqual(await verifier.verify(JWT, OWNER, VESSEL, () => true), {
        ownerId: OWNER,
        vesselId: VESSEL,
        vesselRevision: 3,
        vesselName: 'Synthetic vessel',
        verifiedAt: NOW,
    });
    assert.deepEqual(
        calls.map(([url]) => url),
        [ORIGIN + '/auth/v1/user', ORIGIN + '/rest/v1/rpc/get_owned_vessel_fleet'],
    );
    assert.equal(calls[0][1].headers.Authorization, 'Bearer ' + JWT);
    assert.equal(calls[1][1].body, '{}');
    assert(calls.every(([, options]) => options.redirect === 'error'));
    assert.throws(
        () => new SkillOwnerVerifier({ trustedOrigin: 'https://caller.example', anonKey: () => 'synthetic' }),
    );
});
for (const [name, changes] of Object.entries({
    'foreign JWT subject': { user: { id: OTHER } },
    'deleted account': { user: { id: OWNER, deleted_at: '2026-10-17T00:00:00Z' } },
    'banned account': { user: { id: OWNER, banned_until: '2026-11-17T00:00:00Z' } },
    'self asserted UUID absent from actual fleet': { fleet: { vessels: [] } },
    'foreign owned row': { fleet: { vessels: [{ ...boat, owner_id: OTHER }] } },
    'released boat': { fleet: { vessels: [{ ...boat, released_at: '2026-10-17T00:00:00Z' }] } },
    'archived boat': { fleet: { vessels: [{ ...boat, archived_at: '2026-10-17T00:00:00Z' }] } },
    'missing release authority': { fleet: { vessels: [{ ...boat, released_at: undefined }] } },
    'duplicate ambiguous boat': { fleet: { vessels: [boat, boat] } },
    'malformed ownership revision': { fleet: { vessels: [{ ...boat, revision: '3' }] } },
    'unbounded fleet': { fleet: { vessels: Array(6).fill(boat) } },
}))
    test('owner grant refuses ' + name, async () => {
        const { verifier } = fixture(changes);
        await assert.rejects(verifier.verify(JWT, OWNER, VESSEL, () => true));
    });
test('owner retirement between auth and fleet awaits cannot mint a grant', async () => {
    let current = true,
        requests = 0;
    const verifier = new SkillOwnerVerifier({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        fetchImpl: async () => {
            requests++;
            current = false;
            return json({ id: OWNER });
        },
    });
    await assert.rejects(verifier.verify(JWT, OWNER, VESSEL, () => current));
    assert.equal(requests, 1);
});
test('response original byte ceiling and stalled original body are refused and cancelled', async () => {
    for (const stalled of [false, true]) {
        let cancelled = 0;
        const verifier = new SkillOwnerVerifier({
            trustedOrigin: ORIGIN,
            anonKey: () => 'synthetic',
            now: () => NOW,
            timeoutMs: 20,
            fetchImpl: async () => ({
                status: 200,
                headers: new Headers({ 'Content-Type': 'application/json' }),
                body: new ReadableStream<Uint8Array>({
                    start(c) {
                        if (!stalled) c.enqueue(new Uint8Array(65537));
                    },
                    cancel() {
                        cancelled++;
                    },
                }),
            }),
        });
        await assert.rejects(verifier.verify(JWT, OWNER, VESSEL, () => true));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(cancelled, 1);
    }
});
test('resolve then queued retirement cancels every acquired body exactly once', async () => {
    let current = true,
        cancelled = 0;
    const verifier = new SkillOwnerVerifier({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        fetchImpl: () =>
            new Promise((resolve) => {
                resolve({
                    status: 200,
                    headers: new Headers({ 'Content-Type': 'application/json' }),
                    body: new ReadableStream({
                        cancel() {
                            cancelled++;
                        },
                    }),
                });
                queueMicrotask(() => {
                    current = false;
                });
            }),
    });
    await assert.rejects(verifier.verify(JWT, OWNER, VESSEL, () => current));
    assert.equal(cancelled, 1);
});
test('two actual abort-ignoring transports retain capacity until their late original bodies settle', async () => {
    const finish: ((v: Response) => void)[] = [];
    let calls = 0,
        cancelled = 0;
    const verifier = new SkillOwnerVerifier({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        timeoutMs: 5,
        fetchImpl: () => {
            calls++;
            return new Promise((resolve) => finish.push(resolve));
        },
    });
    for (let i = 0; i < 3; i++) await assert.rejects(verifier.verify(JWT, OWNER, VESSEL, () => true));
    assert.equal(calls, 2);
    for (const resolve of finish)
        resolve(
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            ),
        );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 2);
});
