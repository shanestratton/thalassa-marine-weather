/**
 * Reconnects should follow the network, not the clock.
 *
 * Everything else in NmeaListenerService is a guess about connectivity dressed
 * up as a timer — wait 400 ms, wait 10 s, wait for a foreground. The OS knows
 * the actual moment the phone joins the boat's Wi-Fi or falls off it, so
 * @capacitor/network was added (2026-08-17, at Shane's request) to ask it.
 *
 * Two directions matter, and the losing one matters most. When connectivity
 * goes, our TCP socket is already dead and simply has not been told: left
 * alone it becomes an orphan holding one of the YDWG-02's THREE slots until
 * the gateway times it out, which is exactly how the app locks itself out of a
 * gateway that is streaming perfectly. When connectivity returns, a backoff
 * that has been counting down against a network which no longer exists must
 * not be honoured.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const socket = vi.hoisted(() => ({
    nextClient: 1,
    connect: vi.fn(),
    read: vi.fn(),
    disconnect: vi.fn(),
}));

/**
 * Listeners deliberately persist for the whole file. The service registers its
 * network watch ONCE for the lifetime of the app, so clearing this between
 * tests would leave every test after the first with nothing to emit through —
 * and the tests would pass by doing nothing at all.
 */
const net = vi.hoisted(() => ({
    listeners: [] as ((s: { connected: boolean; connectionType: string }) => void)[],
    addListener: vi.fn(),
}));

vi.mock('capacitor-tcp-socket', () => ({
    TcpSocket: { connect: socket.connect, read: socket.read, disconnect: socket.disconnect },
}));

vi.mock('@capacitor/network', () => ({
    Network: {
        addListener: net.addListener,
        getStatus: async () => ({ connected: true, connectionType: 'wifi' }),
        removeAllListeners: async () => {},
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: () => ({}),
}));

import { NmeaListenerService } from '../services/NmeaListenerService';

const settle = async (turns = 40) => {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
    }
};

const SENTENCE = '$YDRMC,041153.00,A,2712.3137,S,15305.5836,E,0.0,105.3,080826,,,A*1B\r\n';
const blockingTimeout = () =>
    new Promise((_r, reject) => {
        setTimeout(() => reject(Object.assign(new Error('read timeout'), { code: 'TIMEOUT' })), 5000);
    });

/** Push an OS network event through every registered listener. */
const emit = (connected: boolean, connectionType = 'wifi') => {
    for (const fn of net.listeners) fn({ connected, connectionType });
};

/**
 * Each test runs an hour after the last. The service debounces network events
 * on a wall-clock stamp that survives on the singleton between tests, and
 * vi.useFakeTimers() resets the clock to roughly real-now every time — so
 * without this, a later test's event lands BEFORE the previous test's stamp
 * and is silently swallowed as a duplicate.
 */
let clock = new Date('2026-08-17T00:00:00Z').getTime();

beforeEach(() => {
    vi.useFakeTimers();
    clock += 3_600_000;
    vi.setSystemTime(clock);
    socket.nextClient = 1;
    socket.connect.mockReset();
    socket.read.mockReset();
    socket.disconnect.mockReset();
    socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
    socket.disconnect.mockResolvedValue(undefined);
    net.addListener.mockImplementation(async (_event: string, fn: never) => {
        net.listeners.push(fn);
        return { remove: async () => {} };
    });
});

afterEach(() => {
    NmeaListenerService.stop();
    vi.useRealTimers();
});

describe('NMEA network awareness', () => {
    it('registers exactly one OS listener, however many times it is started', async () => {
        // A duplicate listener means every real transition is handled twice —
        // two reconnects racing for one of three slots.
        socket.read.mockImplementation(blockingTimeout);
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        for (let i = 0; i < 3; i++) {
            NmeaListenerService.stop();
            NmeaListenerService.start();
            await settle();
        }

        expect(net.addListener).toHaveBeenCalledTimes(1);
        expect(net.addListener.mock.calls[0][0]).toBe('networkStatusChange');
        expect(net.listeners).toHaveLength(1);
    });

    it('hands the gateway slot back the instant connectivity drops', async () => {
        // The whole point. Without this the socket sits there as an orphan and
        // the gateway keeps counting it against its three-client limit.
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(blockingTimeout);
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        expect(NmeaListenerService.getStatus()).toBe('connected');
        expect(socket.disconnect).not.toHaveBeenCalled();

        emit(false, 'none');
        await settle(10);

        // No clock advance worth the name: the release is immediate, not on the
        // next 5 s read timeout and certainly not on the 15 s watchdog.
        expect(socket.disconnect).toHaveBeenCalledWith({ client: 1 });
        expect(NmeaListenerService.getStatus()).not.toBe('connected');
    });

    it('retries immediately when connectivity returns mid-backoff', async () => {
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        // Climb to the backoff cap, so a pending retry is genuinely far away.
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle();
        }
        const before = socket.connect.mock.calls.length;

        // Walking aboard. The gateway is reachable again.
        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingTimeout);
        emit(true, 'wifi');
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('does not churn a healthy socket when the network merely reports itself', async () => {
        // The false positive that would cost slots: a live, streaming socket
        // torn down because the OS emitted a status event.
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ result: SENTENCE }), 2000)),
        );
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        expect(NmeaListenerService.getStatus()).toBe('connected');

        emit(true, 'wifi');
        await settle(20);

        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(socket.connect).toHaveBeenCalledTimes(1);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('collapses a burst of events into a single reconnect', async () => {
        // iOS reports one real Wi-Fi transition as several reachability flaps.
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle();
        }
        const before = socket.connect.mock.calls.length;

        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingTimeout);

        // Six events inside the debounce window — one real transition.
        for (let i = 0; i < 6; i++) {
            emit(true, 'wifi');
            await settle(3);
        }
        await settle(20);

        // One reconnect, not six. Six would have opened six sockets against a
        // gateway that only has three.
        expect(socket.connect.mock.calls.length).toBe(before + 1);
    });

    it('still releases the slot when the network drops moments after reconnecting', async () => {
        // The hole the burst-debounce opened, found in adversarial review.
        // A gained event stamps the debounce window; a Wi-Fi handoff then drops
        // the link 500 ms later, well inside it. If the loss is debounced like
        // any other event, the freshly-opened socket is never released and
        // becomes an orphan — against a gateway with exactly three slots, and
        // in the one code path added specifically to stop that happening.
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        await vi.advanceTimersByTimeAsync(11_000);
        await settle();

        // Network returns: we reconnect and the connect side spends the window.
        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingTimeout);
        emit(true, 'wifi');
        await settle(20);
        expect(NmeaListenerService.getStatus()).toBe('connected');
        const held = socket.connect.mock.calls.length;
        expect(held).toBeGreaterThan(0);

        // ...and it drops again 500 ms later, deep inside the debounce window.
        await vi.advanceTimersByTimeAsync(500);
        emit(false, 'none');
        await settle(10);

        // A close is idempotent and there is only ever one socket, so there is
        // nothing for a debounce to protect here — only a slot to lose.
        expect(socket.disconnect).toHaveBeenCalled();
        expect(NmeaListenerService.getStatus()).not.toBe('connected');
    });

    it('reconnects on a Wi-Fi-to-Wi-Fi switch, where the payload never changes', async () => {
        // Leaving the marina's network for the boat's own is connected:true /
        // 'wifi' on BOTH sides. Any dedupe on the event payload would discard
        // it — and it is the exact transition this feature exists to catch.
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        // Establish 'wifi' as the last-seen payload, while still failing.
        emit(true, 'wifi');
        await settle(10);
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle();
        }
        const before = socket.connect.mock.calls.length;

        // Same payload, different network — now the gateway answers.
        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingTimeout);
        emit(true, 'wifi');
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('un-parks the connection when the network comes back after the 5-minute give-up', async () => {
        // Park is the state the app reaches after being out of range for five
        // minutes. Before the network watch, only reopening the app escaped it
        // — so the feed stayed dead while the skipper sat aboard, on the boat's
        // own Wi-Fi, with the app already open in front of them.
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        for (let i = 0; i < 40; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            await settle(6);
        }
        const parked = socket.connect.mock.calls.length;

        // Genuinely parked: more time buys no further attempts.
        await vi.advanceTimersByTimeAsync(60_000);
        await settle();
        expect(socket.connect.mock.calls.length).toBe(parked);

        socket.connect.mockImplementation(async () => ({ client: socket.nextClient++ }));
        socket.read.mockImplementation(blockingTimeout);
        emit(true, 'wifi');
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(parked);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });
});
