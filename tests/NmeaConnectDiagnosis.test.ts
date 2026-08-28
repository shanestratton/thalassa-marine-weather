/**
 * The number in "(SwiftSocket.SocketError error 3.)" is NOT an errno.
 *
 * It is the index of a Swift enum case, and `SocketError` has exactly four
 * (Pods/SwiftSocket/Sources/Socket.swift): 0 queryFailed, 1 connectionClosed,
 * 2 connectionTimeout, 3 unknownError. ytcpsocket.c maps a select() expiry to
 * -3 (→ case 2) and ANY non-zero SO_ERROR to -4 (→ case 3), reading the errno
 * and then discarding it.
 *
 * So ECONNREFUSED, EHOSTUNREACH and ENETUNREACH all arrive as the same
 * "error 3" and cannot be told apart from this string. This file used to
 * assert the opposite — that error 3 means the host "ANSWERED and refused the
 * port" — and pinned it. On 2026-08-28 Shane left the house with the app
 * pointed at a home-LAN address and was told his unreachable Pi had answered
 * and refused the connection, and to go check a port and restart a server on
 * a machine he had no route to.
 *
 * The old timeout and no-route cases were tested with English prose
 * ('Operation timed out', 'No route to host') that this native stack never
 * emits, which is exactly how the dead branches stayed green. Every case here
 * now uses the real device strings.
 */
import { describe, expect, it } from 'vitest';
import { diagnoseConnectFailure } from '../services/NmeaListenerService';

const HOST = '192.168.50.152';
const PORT = 10110;

/** What the plugin actually hands JS, for SocketError case `n`. */
const swiftSocket = (n: number) => `The operation couldn't be completed. (SwiftSocket.SocketError error ${n}.)`;

describe('diagnoseConnectFailure', () => {
    it('never claims an unreachable host "answered"', () => {
        // The whole bug in one assertion. Case 3 is the errno-destroyed
        // superset; asserting a refusal from it is a coin flip presented as
        // a fact, and the wrong side sends the skipper to the boat.
        const out = diagnoseConnectFailure(swiftSocket(3), HOST, PORT);
        expect(out).not.toContain('answered but refused');
    });

    it('names both possibilities for case 3, since the errno is gone', () => {
        const out = diagnoseConnectFailure(swiftSocket(3), HOST, PORT);
        expect(out).toContain('nothing is listening on that port');
        expect(out).toContain('no route to that network');
    });

    it('tells the skipper what to check about their own network', () => {
        // The actionable half: this is the "I left the house" case.
        const out = diagnoseConnectFailure(swiftSocket(3), HOST, PORT);
        expect(out).toMatch(/boat's Wi-Fi/);
        expect(out).toMatch(/VPN/);
    });

    it('reads case 2 as the timeout it is', () => {
        // Errno 60 is a Foundation string this stack never produces, so the
        // old branch that matched it could never fire.
        const out = diagnoseConnectFailure(swiftSocket(2), HOST, PORT);
        expect(out).toContain('No answer from');
        expect(out).not.toContain('answered but refused');
    });

    it('still says "answered but refused" when a transport genuinely reports a refusal', () => {
        // Not reachable through SwiftSocket, but the WebSocket dev path and
        // other transports do produce real refusals, and that wording is
        // correct and useful there.
        const out = diagnoseConnectFailure('connect ECONNREFUSED 192.168.50.152:10110', HOST, PORT);
        expect(out).toContain('answered but refused the connection');
    });

    it('still names TCP-slot exhaustion on a reset', () => {
        expect(diagnoseConnectFailure('Connection reset by peer', HOST, PORT)).toContain('TCP slots');
    });

    it('always keeps the raw string for support', () => {
        expect(diagnoseConnectFailure(swiftSocket(3), HOST, PORT)).toContain(swiftSocket(3));
    });

    it('passes an unrecognised failure through unchanged rather than guessing', () => {
        expect(diagnoseConnectFailure('Kernel panic in the bilge', HOST, PORT)).toBe('Kernel panic in the bilge');
    });

    it('names the host and port it actually tried', () => {
        expect(diagnoseConnectFailure(swiftSocket(3), '10.0.0.9', 1456)).toContain('10.0.0.9:1456');
    });
});
