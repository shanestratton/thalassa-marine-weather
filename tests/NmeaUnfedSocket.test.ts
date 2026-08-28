/**
 * A completed TCP handshake is not a feed.
 *
 * The YDWG-02 accepts EVERY connection and feeds only the first three
 * (measured 2026-08-08, re-measured 2026-08-28: three consecutive connects to
 * Serene Summer's gateway all completed the handshake and were reset on first
 * read, because its slots were held by other clients).
 *
 * The service used to declare 'connected' the instant TcpSocket.connect
 * resolved — and, worse, zero the backoff ladder and null the 5-minute
 * give-up clock on the same evidence. Against a full gateway that produced a
 * strobe: flash live, read error, retry 400 ms later because the ladder had
 * been reset, flash live again. Forever, at full speed, never backing off and
 * never parking, because every unfed socket counted as a success.
 *
 * Shane 2026-08-28: "the wind section keeps coming up with no data the live,
 * then no data, then live, then no data, then live".
 *
 * These tests pin the rule: the link is only connected once it has carried
 * traffic, and only then may it reset the ladder.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const socket = vi.hoisted(() => ({
    nextClient: 1,
    connect: vi.fn(),
    read: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock('capacitor-tcp-socket', () => ({
    TcpSocket: { connect: socket.connect, read: socket.read, disconnect: socket.disconnect },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: () => ({}),
}));

import { NmeaListenerService } from '../services/NmeaListenerService';

const SENTENCE = '$YDRMC,041153.00,A,2712.3137,S,15305.5836,E,0.0,105.3,080826,,,A*1B\r\n';

/** A read that waits out its select() and returns nothing — an idle socket. */
const blockingEmpty = () => new Promise((resolve) => setTimeout(() => resolve({ result: '' }), 5000));

const settle = async (turns = 12) => {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
    }
};

beforeEach(() => {
    socket.nextClient = 1;
    socket.connect.mockReset();
    socket.read.mockReset();
    socket.disconnect.mockReset();
    socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
    socket.disconnect.mockResolvedValue(undefined);
    vi.useFakeTimers();
});

afterEach(() => {
    NmeaListenerService.stop();
    vi.useRealTimers();
});

describe('a socket that is accepted but never fed', () => {
    it('does not claim to be connected on the handshake alone', async () => {
        // The gateway's full-slot behaviour: accept, then reset on first read.
        socket.read.mockImplementation(() => Promise.reject(new Error('connection reset by peer')));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(6);

        expect(socket.connect).toHaveBeenCalled();
        expect(NmeaListenerService.getStatus()).not.toBe('connected');
    });

    it('promotes to connected the moment a sentence actually arrives', async () => {
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(blockingEmpty);

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('names the gateway slots once a run of sockets is accepted and dropped unfed', async () => {
        // One is bad luck. A run of them is the YDWG's signature — it is the
        // only common failure that accepts a connection it will not feed.
        socket.read.mockImplementation(() => Promise.reject(new Error('connection reset by peer')));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);
        // Two cycles are needed before the accusation is earned, and the
        // first retry alone sits 400 ms out with the second 2 s behind it.
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(10);
        }

        const err = NmeaListenerService.getLastError() ?? '';
        expect(err).toMatch(/three TCP\s+slots|TCP\s+slots are already taken/);
        expect(err).toMatch(/power-cycle/);
    });

    it('says nothing about slots after a single unfed socket', async () => {
        // Restraint: the accusation has to be earned, or it becomes noise
        // every time a phone briefly loses the boat's Wi-Fi.
        socket.read
            .mockImplementationOnce(() => Promise.reject(new Error('connection reset by peer')))
            .mockResolvedValueOnce({ result: SENTENCE })
            .mockImplementation(blockingEmpty);

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        expect(NmeaListenerService.getLastError() ?? '').not.toMatch(/slots/);
    });

    it('lets the backoff ladder climb instead of resetting it on every unfed socket', async () => {
        // The strobe's engine. connectTcp used to zero `reconnectAttempts` on
        // the handshake, so against a full gateway the ladder was pinned at
        // its 400 ms first rung: the panel flashed several times a second and
        // the 5-minute give-up clock could never arm, because it too was
        // nulled by every "successful" connect.
        //
        // Asserted on the counter rather than by advancing ten seconds of
        // fake time: the reconnect chain reschedules itself inside any such
        // window, and racing it is what makes a timer test flaky.
        socket.read.mockImplementation(() => Promise.reject(new Error('connection reset by peer')));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(0);
        expect(NmeaListenerService.getReconnectAttempts()).toBeGreaterThan(0);
        expect(NmeaListenerService.isReconnecting()).toBe(true);
    });

    it('says a silent port never started, not that the gateway stopped', async () => {
        // "Stopped sending" and "never started" are different faults with
        // different fixes. A port that opens and stays quiet is usually not a
        // gateway at all — telling Shane his gateway "stopped sending" sent
        // him looking at the boat for a wrong address on his phone.
        socket.read.mockImplementation(blockingEmpty);

        NmeaListenerService.configure('192.168.50.152', 10110);
        NmeaListenerService.start();
        await settle(40);
        // Past the 15 s data-silence watchdog.
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(5_000);
            await settle(10);
        }

        const err = NmeaListenerService.getLastError() ?? '';
        expect(err).toContain('has never sent a sentence');
        expect(err).not.toContain('stopped sending');
    });

    it('does not blame the YDWG slots on a port a YDWG does not use', async () => {
        // Measured on Shane's home Pi 2026-08-28: 192.168.50.152:10110
        // accepts a connection and sends nothing, forever. A silent Python
        // listener does exactly what a full gateway does, and "your gateway's
        // three TCP slots are taken" would point him at the boat for a fault
        // that was a wrong address on his phone.
        socket.read.mockImplementation(() => Promise.reject(new Error('connection reset by peer')));

        NmeaListenerService.configure('192.168.50.152', 10110);
        NmeaListenerService.start();
        await settle(40);
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(10);
        }

        const err = NmeaListenerService.getLastError() ?? '';
        expect(err).toContain('not feeding NMEA');
        expect(err).not.toMatch(/three TCP\s+slots|Yacht Devices/);
        // Still says what was observed, so it is not just vaguer.
        expect(err).toContain('accepts the connection then drops it');
    });

    it('still hands the slot back every time, so it cannot lock itself out', async () => {
        // The ladder change must not weaken the discipline from
        // NmeaGatewaySlotLeak: three orphans and the app has taken the whole
        // gateway from itself.
        socket.read.mockImplementation(() => Promise.reject(new Error('connection reset by peer')));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(10);
        }

        expect(socket.disconnect).toHaveBeenCalled();
        expect(socket.disconnect.mock.calls.length).toBeGreaterThanOrEqual(socket.connect.mock.calls.length - 1);
    });
});
