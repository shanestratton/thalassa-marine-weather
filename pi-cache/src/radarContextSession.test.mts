import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadarRawReader } from './radar/rawReader.js';
import { RadarContextSession, radarContextKey } from './radar/contextSession.js';
const owner = '11111111-1111-4111-8111-111111111111',
    pi = '22222222-2222-4222-8222-222222222222',
    session = '33333333-3333-4333-8333-333333333333';
const ownerProof = { ownerId: owner, piDeviceId: pi, pairingId: 'a'.repeat(64), feedId: `pi:${pi}:${'b'.repeat(24)}` };
test('radar lifecycle accepts only a current verified read session and hashes distinct owner/pair/vessel sessions', () => {
    const source = { state: 'reading' as const, session };
    const key = radarContextKey(owner, pi, 'fictional-pair', source);
    assert.match(key!, /^[0-9a-f]{64}$/);
    for (const next of [
        radarContextKey('bad-owner', pi, 'fictional-pair', source),
        radarContextKey(owner, 'bad-pi', 'fictional-pair', source),
        radarContextKey(owner, pi, '', source),
        radarContextKey(owner, pi, 'fictional-pair', { ...source, state: 'connecting' }),
        radarContextKey(owner, pi, 'fictional-pair', { ...source, session: null }),
    ])
        assert.equal(next, null);
    for (const next of [
        radarContextKey('44444444-4444-4444-8444-444444444444', pi, 'fictional-pair', source),
        radarContextKey(owner, pi, 'another-fictional-pair', source),
        radarContextKey(owner, pi, 'fictional-pair', { ...source, session: '55555555-5555-4555-8555-555555555555' }),
    ])
        assert.notEqual(next, key);
});
test('a cached read retires an old account/source immediately and never starts the replacement input', (t) => {
    let current: string | null = 'a'.repeat(64);
    const reader = new RadarRawReader(),
        calls: string[] = [];
    t.mock.method(reader, 'start', (key: string) => {
        calls.push('start:' + key);
    });
    t.mock.method(reader, 'stop', () => {
        calls.push('stop');
    });
    const context = new RadarContextSession(
        reader,
        () => current,
        () => ownerProof,
    );
    t.after(() => context.stop());
    context.refresh();
    assert.deepEqual(calls, ['stop', 'start:' + current]);
    const before = calls.length;
    context.snapshot();
    context.snapshot();
    assert.equal(calls.length, before);
    current = 'b'.repeat(64);
    const snapshot = context.snapshot();
    assert.equal(snapshot.feedId, null);
    assert.equal(snapshot.connected, false);
    assert.deepEqual(calls.slice(before), ['stop']);
    context.refresh();
    assert.deepEqual(calls.slice(before), ['stop', 'stop', 'start:' + current]);
    current = null;
    context.snapshot();
    assert.equal(calls.at(-1), 'stop');
    assert.equal(calls.filter((v) => v.startsWith('start:')).length, 2);
});
test('unknown/malformed context is unavailable and explicit stop leaves no background reader', (t) => {
    let unavailable = true;
    const reader = new RadarRawReader(),
        starts = t.mock.method(reader, 'start');
    const context = new RadarContextSession(reader, () => {
        if (unavailable) throw Error('fictional context failure');
        return 'not-a-context-hash';
    });
    context.start();
    context.snapshot();
    unavailable = false;
    context.refresh();
    assert.equal(starts.mock.callCount(), 0);
    context.stop();
    assert.equal(context.snapshot().feedId, null);
});

test('raw owner envelope refuses missing/mismatched identity even if a reader retains old facts', (t) => {
    const reader = new RadarRawReader(),
        starts: string[] = [];
    t.mock.method(reader, 'start', (key: string) => {
        starts.push(key);
    });
    t.mock.method(reader, 'stop', () => {});
    t.mock.method(reader, 'snapshot', () => ({
        schema: 1 as const,
        source: 'radar' as const,
        configured: true,
        connected: true,
        overloaded: false,
        feedId: 'pi:' + 'd'.repeat(32),
        servedAt: 1767355200000,
        lastFrameAt: 1767355200000,
        lastTargetAt: 1767355200000,
        ownship: {
            feedId: 'pi:' + 'd'.repeat(32),
            position: { lat: 0, lon: 0, at: 1767355200000 },
            heading: null,
            motion: null,
        },
        observations: [],
    }));
    let proof: typeof ownerProof | null = null;
    const context = new RadarContextSession(
        reader,
        () => 'a'.repeat(64),
        () => proof,
    );
    context.refresh();
    assert.equal(starts.length, 0);
    assert.equal(context.snapshot().ownship, null);
    proof = ownerProof;
    context.refresh();
    assert.deepEqual(context.snapshot().owner, ownerProof);
    assert.notEqual(context.snapshot().ownship, null);
    proof = { ...ownerProof, ownerId: '99999999-9999-4999-8999-999999999999' };
    const changed = context.snapshot();
    assert.equal(changed.owner, null);
    assert.equal(changed.ownship, null);
    assert.equal(changed.connected, false);
    assert.equal(starts.length, 1); // GET did not start the replacement.
    context.stop();
});
test('owner change inside a cache read withholds all raw facts before serialization', (t) => {
    const reader = new RadarRawReader();
    let proof = ownerProof;
    t.mock.method(reader, 'start', () => {});
    t.mock.method(reader, 'stop', () => {});
    const oldSnapshot = reader.snapshot.bind(reader);
    t.mock.method(reader, 'snapshot', () => {
        proof = { ...ownerProof, pairingId: 'c'.repeat(64) };
        return oldSnapshot();
    });
    const context = new RadarContextSession(
        reader,
        () => 'a'.repeat(64),
        () => proof,
    );
    context.refresh();
    assert.equal(context.snapshot().owner, null);
    context.stop();
});
