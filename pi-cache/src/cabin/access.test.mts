import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    CabinAccess,
    CABIN_CODE_TTL_MS,
    CABIN_SESSION_TTL_MS,
    validCabinCodeRecord,
    type CabinCodeRecord,
} from './access.js';
const start = 1_792_000_000_000;
const record = (): CabinCodeRecord => ({
    schema: 1,
    nonce: 'a'.repeat(32),
    codeHash: createHash('sha256').update('12345678').digest('hex'),
    issuedAt: start,
    expiresAt: start + CABIN_CODE_TTL_MS,
});
const setup = () => {
    let now = start,
        context: string | null = 'ownerA:0',
        code: CabinCodeRecord | null = record();
    const access = new CabinAccess({ now: () => now, context: () => context, code: () => code });
    return {
        access,
        setNow: (v: number) => {
            now = v;
        },
        setContext: (v: string | null) => {
            context = v;
        },
        setCode: (v: CabinCodeRecord | null) => {
            code = v;
        },
    };
};
test('only correct current cabin code mints a separate read token, without enrolment or command methods', () => {
    const { access } = setup();
    for (const value of [null, '1234', '12345679', 12345678]) assert.equal(access.pair(value, 'peer'), null);
    const session = access.pair('12345678', 'other');
    assert.ok(session);
    assert.match(session.token, /^cabin-[a-f0-9]{64}$/);
    assert.equal(session.expiresAt, start + CABIN_SESSION_TTL_MS);
    assert.ok(access.lease(session.token)?.isCurrent());
    for (const value of ['app-token', '', session.token.toUpperCase(), ['x']]) assert.equal(access.lease(value), null);
    assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(access))
            .filter((k) => !['constructor', 'now', 'refresh'].includes(k))
            .sort(),
        ['close', 'lease', 'pair'],
    );
});
test('owner generation change retires captured leases and A→B→A does not restore an old session', () => {
    const s = setup(),
        token = s.access.pair('12345678', 'peer')!.token,
        lease = s.access.lease(token)!;
    s.setContext('ownerB:1');
    assert.equal(lease.isCurrent(), false);
    s.setContext('ownerA:2');
    assert.equal(s.access.lease(token), null);
    assert.equal(lease.isCurrent(), false);
    assert.ok(s.access.pair('12345678', 'peer2'));
});
test('rotation, missing code, close and clock reversal retire authority immediately', () => {
    for (const retire of ['rotation', 'missing', 'close', 'clock']) {
        const s = setup(),
            session = s.access.pair('12345678', 'peer')!,
            lease = s.access.lease(session.token)!;
        if (retire === 'rotation') s.setCode({ ...record(), nonce: 'b'.repeat(32) });
        if (retire === 'missing') s.setCode(null);
        if (retire === 'close') s.access.close();
        if (retire === 'clock') s.setNow(start - 6_000);
        assert.equal(lease.isCurrent(), false);
        assert.equal(s.access.lease(session.token), null);
    }
});
test('code expiry holds new pairings; existing read sessions have a fixed unrenewed maximum lifetime', () => {
    const s = setup(),
        session = s.access.pair('12345678', 'peer')!;
    s.setNow(start + CABIN_CODE_TTL_MS + 1);
    assert.equal(s.access.pair('12345678', 'other'), null);
    assert.ok(s.access.lease(session.token)?.isCurrent());
    s.setNow(start + CABIN_SESSION_TTL_MS);
    assert.equal(s.access.lease(session.token), null);
});
test('attempt, viewer and code-shape bounds refuse excess without unbounded admission', () => {
    const s = setup();
    for (let n = 0; n < 5; n++) assert.equal(s.access.pair('00000000', 'same'), null);
    assert.equal(s.access.pair('12345678', 'same'), null);
    for (let n = 0; n < 8; n++) assert.ok(s.access.pair('12345678', 'different' + n));
    assert.equal(s.access.pair('12345678', 'ninth'), null);
    for (const v of [
        { ...record(), expiresAt: start + CABIN_CODE_TTL_MS + 1 },
        { ...record(), issuedAt: NaN },
        { ...record(), nonce: 'x' },
        null,
    ])
        assert.equal(validCabinCodeRecord(v, start), false);
});
