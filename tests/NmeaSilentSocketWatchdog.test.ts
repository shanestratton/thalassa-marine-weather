/**
 * A socket that is open but silent is not connected — it is dead and lying.
 *
 * When boat Wi-Fi drops, the usual result is a HALF-OPEN TCP connection: no
 * FIN ever arrives, so the phone's socket stays "established" against a peer
 * that is gone. The read loop treated every timeout as the normal quiet-bus
 * case and `continue`d forever, so the service sat at status 'connected',
 * reporting a healthy gateway, receiving nothing — and holding one of the
 * YDWG-02's three slots until the gateway itself timed it out.
 *
 * Shane, 2026-08-17: "i notice that the ydwg-02 is difficult to connect to at
 * times ... particularly after a disconnection and reconnection."
 *
 * The gateway streams continuously — 3,146 sentences in 91 s, measured on
 * Serene Summer — so prolonged silence is diagnostic, not ambiguous. These
 * tests pin both halves of the fix: silence eventually tears the socket down,
 * and a stream that is still flowing never does.
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

/** Flush the service's chain of awaited dynamic imports without moving the
 *  clock far enough to trip the very timers under test. */
const settle = async (turns = 40) => {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
    }
};

const SENTENCE = '$YDRMC,041153.00,A,2712.3137,S,15305.5836,E,0.0,105.3,080826,,,A*1B\r\n';
/**
 * WHAT AN iOS READ TIMEOUT ACTUALLY LOOKS LIKE.
 *
 * Not a rejection. capacitor-tcp-socket's TcpSocketPlugin.swift does
 * `guard let response = client.read(...) else { call.resolve(["result": ""]) }`,
 * and TCPClient.read returns nil whenever ytcpsocket_pull gives `readLen <= 0`
 * — which covers a select() timeout, EOF and RST alike. So it blocks for the
 * full timeout and then RESOLVES EMPTY.
 *
 * An earlier version of these tests mocked a rejection with `code: 'TIMEOUT'`,
 * which no iOS build ever produces. The tests passed against a transport that
 * does not exist, and the watchdog they were certifying could not fire on the
 * one platform this ships to.
 */
const blockingEmpty = () =>
    new Promise((resolve) => {
        setTimeout(() => resolve({ result: '' }), 5000);
    });

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

describe('silent-socket watchdog', () => {
    it('tears down and reconnects when a connected gateway goes silent', async () => {
        // Data first — so the service genuinely reaches 'connected' — then the
        // stream stops dead while the socket stays open. This is the half-open
        // case, and it used to last forever.
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(blockingEmpty);

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        expect(NmeaListenerService.getStatus()).toBe('connected');
        expect(socket.disconnect).not.toHaveBeenCalled();

        // Ten seconds of silence is not yet proof — the app must not churn the
        // gateway's slots over a brief lull.
        await vi.advanceTimersByTimeAsync(10_000);
        await settle();
        expect(socket.disconnect).not.toHaveBeenCalled();

        // Past the threshold it is proof. The dead slot is handed back...
        await vi.advanceTimersByTimeAsync(15_000);
        await settle();
        expect(socket.disconnect).toHaveBeenCalledWith({ client: 1 });

        // ...and a fresh socket replaces it, rather than the app sitting there
        // claiming to be connected to a gateway that stopped talking.
        await vi.advanceTimersByTimeAsync(2_000);
        await settle();
        expect(socket.connect.mock.calls.length).toBeGreaterThan(1);
    });

    it('never tears down a socket that is still delivering', async () => {
        // The false-positive that would matter: a healthy stream killed on a
        // fixed timer. Every read here returns a sentence, so silence never
        // accumulates no matter how long the session runs.
        socket.read.mockImplementation(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve({ result: SENTENCE }), 5000);
                }),
        );

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        await vi.advanceTimersByTimeAsync(120_000);
        await settle();

        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(socket.connect).toHaveBeenCalledTimes(1);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('spots a closed socket from the SPEED of an empty read, not the 15s clock', async () => {
        // EOF and RST come back as `{result: ''}` too — identical in value to a
        // timeout, and separable only by how long the call took. A genuine idle
        // timeout blocks inside select() for the full 5 s; a finished socket
        // returns instantly. Waiting out the silence watchdog for something the
        // transport already told us in milliseconds is fifteen seconds of a
        // gateway slot held for nothing.
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockResolvedValue({ result: '' });

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        await vi.advanceTimersByTimeAsync(1_000);
        await settle();

        expect(socket.disconnect).toHaveBeenCalledWith({ client: 1 });
    });

    it('does not hot-spin on a socket that returns empty immediately', async () => {
        // Every read is one call across the single serial Capacitor bridge
        // queue that the whole app shares — maps, geolocation, haptics, all of
        // it. An instantly-resolving empty read with no pause between
        // iterations does not merely waste CPU, it starves the bridge.
        socket.read.mockResolvedValue({ result: '' });

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        await vi.advanceTimersByTimeAsync(2_000);
        await settle();

        // A handful of paced reads, not thousands of unpaced ones.
        expect(socket.read.mock.calls.length).toBeLessThan(30);
    });

    it('retries within a second of the first failure, not two', async () => {
        // The gateway is on the same Wi-Fi. When a connect fails, the honest
        // assumption is that it is already back — so attempt #2 is immediate
        // and the exponential ladder starts after it. The old first step was
        // a flat 2 s, which is most of what "slow to reconnect" felt like.
        socket.connect.mockRejectedValue(new Error('connection refused'));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        expect(socket.connect).toHaveBeenCalledTimes(1);

        // 400 ms base + up to 250 ms of jitter, so one second is a safe fence
        // that still fails against the old 2 s.
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
        expect(socket.connect).toHaveBeenCalledTimes(2);
    });

    it('retries immediately when the app is foregrounded mid-ladder', async () => {
        // Walking aboard is the moment the network changes, and it is also the
        // moment the skipper is looking at the screen. A countdown started
        // against the old network must not be honoured.
        socket.connect.mockRejectedValue(new Error('connection refused'));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        // Climb the ladder to its cap so a pending retry is genuinely far off.
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle();
        }
        const before = socket.connect.mock.calls.length;

        // Now the phone comes out of a pocket. No clock advance at all.
        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingEmpty);
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('caps backoff at ten seconds so a LAN device is never waited on for half a minute', async () => {
        socket.connect.mockRejectedValue(new Error('connection refused'));

        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        // Climb well past the point where the old ladder pinned itself at 30 s.
        for (let i = 0; i < 8; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle();
        }
        const attemptsAtCap = socket.connect.mock.calls.length;

        // One more capped interval must still produce an attempt. Under a 30 s
        // cap this window would pass in silence.
        await vi.advanceTimersByTimeAsync(11_000);
        await settle();
        expect(socket.connect.mock.calls.length).toBeGreaterThan(attemptsAtCap);
    });
});
