/**
 * The gateway card used to show the raw native error and nothing else:
 *   "The operation couldn't be completed. (SwiftSocket.SocketError error 3.)"
 * That names an errno and no more, so a refused port and an unreachable boat
 * looked identical on screen — and both got rediagnosed as broken hardware.
 *
 * Shane 2026-08-28, on a gateway that pinged fine but refused 1456: "the nmea
 * will not connect. so we also need to fix that again." Error 3 is precisely
 * the informative case — the host ANSWERED and refused the port — and the UI
 * was throwing that away.
 */
import { describe, expect, it } from 'vitest';
import { diagnoseConnectFailure } from '../services/NmeaListenerService';

const HOST = '192.168.50.152';
const PORT = 1456;
const RAW3 = "The operation couldn't be completed. (SwiftSocket.SocketError error 3.)";

describe('diagnoseConnectFailure', () => {
    it('reads error 3 as "answered but refused the port", not as unreachable', () => {
        const out = diagnoseConnectFailure(RAW3, HOST, PORT);
        expect(out).toContain('refused the connection');
        expect(out).toContain('nothing is listening on port 1456');
        expect(out).not.toMatch(/no route|unreachable/i);
    });

    it('always keeps the raw errno for support', () => {
        // The plain-English half is what gets read; the errno is what gets
        // pasted into a bug report.
        expect(diagnoseConnectFailure(RAW3, HOST, PORT)).toContain(RAW3);
    });

    it('separates a timeout from a refusal', () => {
        const out = diagnoseConnectFailure('Operation timed out', HOST, PORT);
        expect(out).toContain('No answer');
        expect(out).not.toContain('refused the connection');
    });

    it('separates no-route from both', () => {
        const out = diagnoseConnectFailure('No route to host', HOST, PORT);
        expect(out).toContain('No route to 192.168.50.152');
        expect(out).toContain('subnet router or VPN');
    });

    it('names the TCP-slot exhaustion a Yacht Devices gateway actually hits', () => {
        // The YDWG-02 serves a small fixed number of TCP clients; a capture or
        // a second app holding them looks like a flapping connection.
        const out = diagnoseConnectFailure('Connection reset by peer', HOST, PORT);
        expect(out).toContain('TCP slots');
    });

    it('passes an unrecognised failure through unchanged rather than guessing', () => {
        expect(diagnoseConnectFailure('Kernel panic in the bilge', HOST, PORT)).toBe('Kernel panic in the bilge');
    });

    it('names the host and port it actually tried', () => {
        const out = diagnoseConnectFailure(RAW3, '10.0.0.9', 10110);
        expect(out).toContain('10.0.0.9:10110');
    });
});
