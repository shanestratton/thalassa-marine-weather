/**
 * A parked gateway socket restarts on app foreground only where the
 * instrument policy allows it.
 *
 * The listener parks after five minutes of failed reconnects and used to
 * restart on the next foreground, whoever had opened it. A socket the policy
 * opened as a silent Pi's fallback, foregrounded from ashore, took one of the
 * gateway's few client slots from 900 km away (Shane 2026-10-07: "gateway
 * settings, sometime take over"). The policy now has the say
 * (InstrumentSourcePolicy.mayRestartSocket); with no say given, the old
 * behaviour stands, for a boat with no Pi whose gateway is her only link.
 *
 * The same say covers the two other ways the socket restarts on its own: an
 * enabled socket's immediate retry on foreground or a network change, and
 * each rung of its reconnect ladder (an overdue timer fires the moment a
 * suspended app wakes, wherever the phone now is).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({ connect: vi.fn(), read: vi.fn(), disconnect: vi.fn() }));

vi.mock('capacitor-tcp-socket', () => ({
    TcpSocket: { connect: socket.connect, read: socket.read, disconnect: socket.disconnect },
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

/** Fail every connect for longer than the give-up window, until the listener parks. */
async function parkTheSocket() {
    socket.connect.mockRejectedValue(new Error('connection refused'));
    NmeaListenerService.configure('192.0.2.151', 1457);
    NmeaListenerService.start();
    await settle();
    for (let i = 0; i < 40 && NmeaListenerService.isEnabled(); i++) {
        await vi.advanceTimersByTimeAsync(11_000);
        await settle(5);
    }
    expect(NmeaListenerService.isEnabled()).toBe(false);
}

beforeEach(() => {
    socket.connect.mockReset();
    socket.read.mockReset();
    socket.disconnect.mockReset();
    socket.disconnect.mockResolvedValue(undefined);
    vi.useFakeTimers();
});

afterEach(() => {
    NmeaListenerService.setResumeGate(null);
    NmeaListenerService.stop();
    vi.useRealTimers();
});

describe('the parked socket asks before it resumes', () => {
    it('stays parked on foreground when the policy says no', async () => {
        await parkTheSocket();
        const gate = vi.fn(() => false);
        NmeaListenerService.setResumeGate(gate);
        const before = socket.connect.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(20);
        expect(gate).toHaveBeenCalled();
        expect(socket.connect.mock.calls.length).toBe(before);
        expect(NmeaListenerService.isEnabled()).toBe(false);
    });

    it('resumes on foreground when the policy says yes, and with no gate at all', async () => {
        await parkTheSocket();
        NmeaListenerService.setResumeGate(() => true);
        const before = socket.connect.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(20);
        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);

        NmeaListenerService.stop();
        await parkTheSocket();
        NmeaListenerService.setResumeGate(null);
        const again = socket.connect.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(20);
        expect(socket.connect.mock.calls.length).toBeGreaterThan(again);
    });
});

describe('an enabled socket on its reconnect ladder asks too', () => {
    /** Connect once, then lose it: the socket is enabled, disconnected, with a rung queued. */
    async function dropTheSocket() {
        socket.connect.mockRejectedValue(new Error('connection refused'));
        NmeaListenerService.configure('192.0.2.151', 1457);
        NmeaListenerService.start();
        await settle();
        expect(NmeaListenerService.isEnabled()).toBe(true);
    }

    it('foregrounded where the policy says no: no immediate retry', async () => {
        await dropTheSocket();
        const gate = vi.fn((kind: string) => kind !== 'retry');
        NmeaListenerService.setResumeGate(gate);
        const before = socket.connect.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
        expect(gate).toHaveBeenCalledWith('retry');
        expect(socket.connect.mock.calls.length).toBe(before);
    });

    it('a rung that comes due where the policy says no is skipped, and the ladder climbs on', async () => {
        await dropTheSocket();
        NmeaListenerService.setResumeGate((kind) => kind !== 'rung');
        const before = socket.connect.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        await settle(5);
        expect(socket.connect.mock.calls.length).toBe(before);
        expect(NmeaListenerService.isEnabled()).toBe(true);
        // Allowed again: the next rung connects.
        NmeaListenerService.setResumeGate(() => true);
        await vi.advanceTimersByTimeAsync(60_000);
        await settle(5);
        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
    });

    it('with no gate, foreground retries at once as it always has', async () => {
        await dropTheSocket();
        NmeaListenerService.setResumeGate(null);
        const before = socket.connect.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(5);
        expect(socket.connect.mock.calls.length).toBeGreaterThan(before);
    });
});
