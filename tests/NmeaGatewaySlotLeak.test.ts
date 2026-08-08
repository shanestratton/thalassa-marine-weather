/**
 * The YDWG-02's TCP server has THREE usable client slots. Measured on Serene
 * Summer's gateway 2026-08-08: connections four, five and six complete the
 * handshake and are then reset by the gateway — accepted, never fed.
 *
 * So a socket the app abandons without closing is not a tidiness problem, it
 * is a countdown. Three read errors and the app has filled every slot with its
 * own orphans and locked itself out of a gateway that is streaming perfectly.
 * These tests pin the discipline that prevents it: every path off a socket
 * closes it, and no path opens a second one on top of a live one.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const socket = vi.hoisted(() => ({
    nextClient: 1,
    connect: vi.fn(),
    read: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock('capacitor-tcp-socket', () => ({
    TcpSocket: {
        connect: socket.connect,
        read: socket.read,
        disconnect: socket.disconnect,
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: () => ({}),
}));

import { NmeaListenerService } from '../services/NmeaListenerService';

/**
 * Let the service's chain of awaited dynamic imports settle. Microtask turns
 * alone are not enough — the transport is reached through `await
 * import('capacitor-tcp-socket')` at three separate points, and module
 * resolution lands on the macrotask queue. Advancing the (fake) clock a
 * millisecond per turn flushes both, and stays far short of the reconnect
 * backoff so it can't smuggle in an extra cycle.
 */
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

describe('NMEA gateway slot discipline', () => {
    it('closes the socket after a read error instead of abandoning the slot', async () => {
        // One good read, then a hard failure — a gateway reset, not a timeout.
        socket.read
            .mockResolvedValueOnce({
                result: '$YDRMC,041153.00,A,2712.3137,S,15305.5836,E,0.0,105.3,080826,,,A*1B\r\n',
            })
            .mockRejectedValue(new Error('socket closed by peer'));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        expect(socket.connect).toHaveBeenCalled();
        // The leaked-slot bug: the handle was nulled and a new socket opened
        // without ever telling the gateway to let the old one go.
        expect(socket.disconnect).toHaveBeenCalledWith({ client: 1 });
    });

    it('never opens a second socket while one is still held', async () => {
        socket.read.mockRejectedValue(new Error('socket closed by peer'));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        // Drive several reconnect cycles. Each must release before it opens,
        // so opens never outrun closes by more than the one currently held —
        // which is what keeps the app inside three slots forever.
        for (let cycle = 0; cycle < 4; cycle++) {
            await vi.advanceTimersByTimeAsync(35_000);
            await settle(40);
        }

        const opened = socket.connect.mock.calls.length;
        const closed = socket.disconnect.mock.calls.length;
        expect(opened).toBeGreaterThan(1);
        expect(opened - closed).toBeLessThanOrEqual(1);
    });

    it('a read timeout is not a disconnect — it keeps the slot and reads on', async () => {
        // Timeouts are the normal quiet-bus case. Closing on one would churn
        // the gateway's slots for no reason at all.
        //
        // The steady state has to be a read that never settles. A real
        // TcpSocket.read blocks for TCP_READ_TIMEOUT_S, which is the only
        // thing pacing this loop — a mock that resolves instantly turns it
        // into a hot spin that eats the worker alive (it did).
        const timeout = Object.assign(new Error('read timeout'), { code: 'TIMEOUT' });
        socket.read
            .mockRejectedValueOnce(timeout)
            .mockRejectedValueOnce(timeout)
            .mockImplementation(() => new Promise(() => {}));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle(40);

        // Two timeouts survived: still one socket, never closed, still reading.
        expect(socket.read.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(socket.connect).toHaveBeenCalledTimes(1);
        expect(socket.disconnect).not.toHaveBeenCalled();
    });
});
