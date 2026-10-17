import assert from 'node:assert/strict';
import { test } from 'node:test';
import { radarServerContext, createRadarControllerVerifier } from './radar/serverContext.js';
import { wakeEnrollmentRevision, wakePairingId } from './wakeKeeper/contract.js';
const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002',
    relay = 'fictional-relay-identity';
const source = { state: 'reading' as const, session: '00000000-0000-4000-8000-000000000004' };
const device = {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'Generated',
    enrolledAt: '2026-01-02T12:00:00Z',
    lastSeenAt: '2026-01-02T12:00:00Z',
};
const controller = { deviceId: device.id, enrollmentRevision: wakeEnrollmentRevision(device) };
test('root radar context requires verified self and exact server pairing; unrelated observation clocks never renew it', () => {
    const c = radarServerContext(owner, pi, relay, source)!;
    assert.equal(c.pairingId, wakePairingId(owner, pi, relay));
    assert.match(c.feedId, new RegExp('^pi:' + pi + ':[a-f0-9]{24}$'));
    assert.deepEqual(radarServerContext(owner, pi, relay, { ...source }), c);
    for (const s of [null, { ...source, state: 'unavailable' as const }, { ...source, session: null }])
        assert.equal(radarServerContext(owner, pi, relay, s), null);
    assert.equal(radarServerContext('another-owner', pi, relay, source), null);
    assert.equal(radarServerContext(owner, pi, 'short', source), null);
    assert.notEqual(
        radarServerContext(owner, pi, relay, { ...source, session: '00000000-0000-4000-8000-000000000005' })!
            .contextToken,
        c.contextToken,
    );
});
test('controller proof distinguishes current registration, confirmed revocation and unavailable storage', async () => {
    const c = radarServerContext(owner, pi, relay, source)!;
    assert.equal(
        await createRadarControllerVerifier(
            () => c,
            async () => [device],
        )(controller, c),
        true,
    );
    assert.equal(
        await createRadarControllerVerifier(
            () => c,
            async () => [],
        )(controller, c),
        false,
    );
    assert.equal(
        await createRadarControllerVerifier(
            () => c,
            async () => [{ ...device, enrolledAt: '2026-01-03T12:00:00Z' }],
        )(controller, c),
        false,
    );
    await assert.rejects(
        createRadarControllerVerifier(
            () => c,
            async () => {
                throw Error('synthetic unavailable');
            },
        )(controller, c),
        /synthetic unavailable/,
    );
});
test('an enrollment read cannot authorize a retired owner or source across an await', async () => {
    const c = radarServerContext(owner, pi, relay, source)!;
    let current: typeof c | null = c;
    let release!: (devices: (typeof device)[]) => void;
    const waiting = new Promise<(typeof device)[]>((r) => {
        release = r;
    });
    const pending = createRadarControllerVerifier(
        () => current,
        () => waiting,
    )(controller, c);
    current = radarServerContext(owner, pi, relay, { ...source, session: '00000000-0000-4000-8000-000000000006' });
    release([device]);
    assert.equal(await pending, false);
    let reads = 0;
    assert.equal(
        await createRadarControllerVerifier(
            () => null,
            async () => {
                reads++;
                return [device];
            },
        )(controller, c),
        false,
    );
    assert.equal(reads, 0);
});
