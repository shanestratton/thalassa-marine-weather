/**
 * The Pi echoes the address a phone's request came from, so the phone can tell
 * "on the boat's Wi-Fi" from "over a VPN to her network" (Shane 2026-10-07).
 * Fictional TEST-NET and CGNAT addresses only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requestPath, seenFromAddress } from './requestPath.js';

test('a plain IPv4 source is echoed as it is', () => {
    assert.equal(seenFromAddress('192.0.2.37'), '192.0.2.37');
    assert.equal(seenFromAddress('100.101.102.103'), '100.101.102.103');
});

test('an IPv4-mapped IPv6 source is echoed as its IPv4 address', () => {
    assert.equal(seenFromAddress('::ffff:192.0.2.37'), '192.0.2.37');
    assert.equal(seenFromAddress('::FFFF:198.51.100.1'), '198.51.100.1');
});

test('anything else is null, never a guess', () => {
    assert.equal(seenFromAddress(undefined), null);
    assert.equal(seenFromAddress(null), null);
    assert.equal(seenFromAddress(''), null);
    assert.equal(seenFromAddress('fe80::1'), null);
    assert.equal(seenFromAddress('2001:db8::7'), null);
    assert.equal(seenFromAddress('192.0.2.300'), null);
    assert.equal(seenFromAddress('192.0.2'), null);
});

test('the wire shape: where the request came from, and the Pi’s own address that took it', () => {
    assert.deepEqual(requestPath('::ffff:192.0.2.37', '::ffff:192.0.2.180'), {
        seen_from: '192.0.2.37',
        seen_at: '192.0.2.180',
    });
    // Over the Pi's own tailnet address.
    assert.deepEqual(requestPath('100.101.102.103', '100.101.102.104'), {
        seen_from: '100.101.102.103',
        seen_at: '100.101.102.104',
    });
    assert.deepEqual(requestPath(undefined), { seen_from: null, seen_at: null });
    assert.deepEqual(requestPath('192.0.2.37', 'fe80::1'), { seen_from: '192.0.2.37', seen_at: null });
});

test('/api/telemetry carries the echo on both of its answers, read off the socket', () => {
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const route = server.slice(
        server.indexOf("app.get('/api/telemetry'"),
        server.indexOf("app.post('/api/anchor/watch'"),
    );
    assert.match(route, /const requestRoute = requestPath\(req\.socket\.remoteAddress, req\.socket\.localAddress\)/);
    assert.equal((route.match(/path: requestRoute,/g) ?? []).length, 2);
    // Never a client-written header.
    assert.doesNotMatch(route, /x-forwarded-for/i);
});
