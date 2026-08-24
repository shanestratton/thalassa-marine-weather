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

/**
 * Drain the pending work, without making the answer depend on how busy the
 * machine is.
 *
 * The connect path awaits REAL promises (the plugin bridge and its retry
 * chain), which resolve on the real event loop no matter how the fake clock is
 * driven. Each `advanceTimersByTimeAsync` yields to that loop once, so a fixed
 * budget of turns gave a loaded machine a fixed number of chances — and under
 * a full parallel suite that was sometimes too few. The symptom was this file
 * failing a DIFFERENT test on maybe one run in three while passing every time
 * in isolation (2026-08-24).
 *
 * Two parts, deliberately:
 *   1. `turns` iterations that advance the clock 1 ms each — the timer-driven
 *      work (reconnect ladder, watchdog) needs real fake-time to pass.
 *   2. a long tail of ZERO-advance yields. These add no fake time at all, so
 *      nothing shifts for the tests that assert on the grace window or the
 *      5-minute give-up ladder; they simply hand the real event loop many more
 *      chances to settle promises that a busy machine resolves slowly.
 */
const settle = async (turns = 40) => {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
    }
    for (let i = 0; i < 200; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
};

const SENTENCE = '$YDRMC,041153.00,A,2712.3137,S,15305.5836,E,0.0,105.3,080826,,,A*1B\r\n';
/** An iOS read timeout: blocks the full timeout, then RESOLVES empty — it does
 *  not reject. See the long note in NmeaSilentSocketWatchdog.test.ts. */
const blockingEmpty = () =>
    new Promise((resolve) => {
        setTimeout(() => resolve({ result: '' }), 5000);
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
        socket.read.mockImplementation(blockingEmpty);
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
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(blockingEmpty);
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        expect(NmeaListenerService.getStatus()).toBe('connected');
        expect(socket.disconnect).not.toHaveBeenCalled();

        // Past the grace window in which recent traffic would vouch for the
        // link (see the next test) — here the gateway has genuinely gone quiet.
        await vi.advanceTimersByTimeAsync(4_000);
        await settle(10);

        emit(false, 'none');
        await settle(10);

        // Released on the event itself, not on the next 5 s read and certainly
        // not on the 15 s watchdog.
        expect(socket.disconnect).toHaveBeenCalledWith({ client: 1 });
        expect(NmeaListenerService.getStatus()).not.toBe('connected');
    });

    it('keeps the socket when the OS cries offline but sentences are still arriving', async () => {
        // The boat's Wi-Fi losing its uplink is the ordinary case, not the
        // exotic one: connected:false is derived from reachability flags for
        // 0.0.0.0, so it means "no default route" — a claim about the WAN. The
        // gateway on the same LAN carries on regardless, and tearing down a
        // socket that is delivering because the internet went away would be a
        // self-inflicted outage at exactly the moment offline data matters.
        socket.read.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ result: SENTENCE }), 1000)),
        );
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        await vi.advanceTimersByTimeAsync(3_000);
        await settle();
        expect(NmeaListenerService.getStatus()).toBe('connected');

        emit(false, 'none');
        await settle(10);

        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(NmeaListenerService.getStatus()).toBe('connected');
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
        socket.read.mockImplementation(blockingEmpty);
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
        socket.read.mockImplementation(blockingEmpty);

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
        socket.read.mockImplementation(blockingEmpty);
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
        socket.read.mockImplementation(blockingEmpty);
        emit(true, 'wifi');
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });

    it('does not open a second socket while a connect is still in flight', async () => {
        // TcpSocket.connect can hang for seconds against an unreachable host,
        // and until it settles tcpClientId is still null — so connectTcp's own
        // defensive release finds nothing to release and a second connect sails
        // straight past it. The first handle then lands and is overwritten:
        // one of three slots gone, held by a socket nothing can now close.
        socket.connect.mockImplementation(() => new Promise(() => {}));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        expect(socket.connect).toHaveBeenCalledTimes(1);

        // Every retry trigger there is, while that connect hangs unresolved.
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(2_000);
            emit(true, 'wifi');
            document.dispatchEvent(new Event('visibilitychange'));
            await settle(10);
        }

        expect(socket.connect).toHaveBeenCalledTimes(1);
    });

    it('makes a live socket prove itself when the interface changes underneath it', async () => {
        // Stepping off the boat onto 5G is connected:true / 'cellular' — never
        // connected:false — so no teardown branch sees it, and the retry branch
        // is skipped because status is still 'connected'. The socket over the
        // departed Wi-Fi is dead and nothing had noticed.
        socket.read.mockResolvedValueOnce({ result: SENTENCE }).mockImplementation(blockingEmpty);
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();
        emit(true, 'wifi'); // establish the interface we are leaving
        await settle(5);
        expect(NmeaListenerService.getStatus()).toBe('connected');
        expect(socket.disconnect).not.toHaveBeenCalled();

        emit(true, 'cellular');
        await settle(5);

        // Not torn down on suspicion — given a few seconds to deliver, and
        // retired when it cannot.
        await vi.advanceTimersByTimeAsync(6_000);
        await settle(10);
        expect(socket.disconnect).toHaveBeenCalled();
    });

    it('lets the backoff ladder keep climbing while the network flaps', async () => {
        // Each network event collapses the pending retry and reconnects — that
        // is the feature. Rewinding the ladder as well is not: under a flapping
        // Wi-Fi the events never stop, the ladder never leaves its first rung,
        // and the retry rate multiplies against a gateway with three slots.
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.168.1.151', 1456);
        NmeaListenerService.start();
        await settle();

        // A minute of flapping, one event every two seconds.
        for (let i = 0; i < 30; i++) {
            emit(true, 'wifi');
            await settle(4);
            await vi.advanceTimersByTimeAsync(2_000);
            await settle(4);
        }

        // Close to one attempt per real event. Unrationed, the ladder would sit
        // at its 400 ms first rung and fire several times per gap instead.
        // Lower bound too, so a service that has wedged itself and stopped
        // connecting entirely cannot pass this by doing nothing.
        expect(socket.connect.mock.calls.length).toBeGreaterThan(20);
        expect(socket.connect.mock.calls.length).toBeLessThan(60);
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
        socket.read.mockImplementation(blockingEmpty);
        emit(true, 'wifi');
        await settle(20);

        expect(socket.connect.mock.calls.length).toBeGreaterThan(parked);
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });
});
