import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';
const fixture = vi.hoisted(() => ({
    platform: 'ios',
    open: vi.fn(),
    tcp: vi.fn(),
    sessions: [] as {
        options: {
            onSentence(s: string, at: number): void;
            onClosed(reason: string): void;
            onListening?(ip: string): void;
        };
        stop: ReturnType<typeof vi.fn>;
    }[],
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => fixture.platform === 'ios', getPlatform: () => fixture.platform },
    registerPlugin: () => ({}),
}));
vi.mock('@capacitor/network', () => ({ Network: { addListener: async () => ({ remove: async () => undefined }) } }));
vi.mock('capacitor-tcp-socket', () => ({ TcpSocket: { connect: fixture.tcp, disconnect: async () => undefined } }));
vi.mock('../services/nmea/udpTransport', () => ({ openUdpTransport: fixture.open }));
import { NmeaListenerService } from '../services/NmeaListenerService';

const internal = NmeaListenerService as unknown as { emitSample(): void };
const settle = async () => {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fixture.sessions.length = 0;
    fixture.platform = 'ios';
    vi.clearAllMocks();
    fixture.open.mockImplementation((options) => {
        const stop = vi.fn();
        fixture.sessions.push({ options, stop });
        options.onListening?.('192.168.50.2');
        return { ready: Promise.resolve(), stop };
    });
    NmeaListenerService.configure('192.168.50.1', 10110, 'udp');
});
afterEach(() => {
    NmeaListenerService.stop();
    NmeaListenerService.setResumeGate(null);
    NmeaListenerService.configure('192.168.50.1', 10110, 'tcp');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.useRealTimers();
});
describe('real listener UDP integration', () => {
    it('does not retry a permanently unsupported platform or open a substitute transport', async () => {
        fixture.platform = 'web';
        fixture.open.mockImplementation(() => ({
            ready: Promise.reject(new Error('Unicast UDP needs the iPhone or iPad app')),
            stop: vi.fn(),
        }));
        NmeaListenerService.start();
        await settle();
        expect(NmeaListenerService.getStatus()).toBe('error');
        expect(NmeaListenerService.isEnabled()).toBe(false);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(fixture.open).toHaveBeenCalledTimes(1);
        expect(fixture.tcp).not.toHaveBeenCalled();
    });
    it('opens only UDP, waits for a supported sentence, and retains native receipt time', async () => {
        const output: NmeaSample[] = [],
            off = NmeaListenerService.onSample((sample) => output.push(sample));
        try {
            NmeaListenerService.start();
            await settle();
            expect(fixture.tcp).not.toHaveBeenCalled();
            expect(NmeaListenerService.getStatus()).toBe('connecting');
            expect(NmeaListenerService.getConnectionInfo()).toMatchObject({
                transport: 'udp',
                localAddress: '192.168.50.2',
            });
            const at = Date.now() - 3000;
            fixture.sessions[0].options.onSentence('$GPXYZ,invalid', at);
            expect(NmeaListenerService.getStatus()).toBe('connecting');
            fixture.sessions[0].options.onSentence('$GPVTG,45,T,,M,5,N,9.26,K,D', at);
            expect(NmeaListenerService.getStatus()).toBe('connected');
            internal.emitSample();
            expect(output[0]).toMatchObject({
                sog: 5,
                cog: 45,
                timestamp: at,
                measurementTimes: { sog: at, cogTrue: at },
            });
        } finally {
            off();
        }
    });
    it('closes on background and asks the Pi-first policy before foreground restart', async () => {
        NmeaListenerService.start();
        await settle();
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(fixture.sessions[0].stop).toHaveBeenCalledTimes(1);
        expect(NmeaListenerService.getStatus()).toBe('disconnected');
        NmeaListenerService.setResumeGate(() => false);
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.open).toHaveBeenCalledTimes(1);
        NmeaListenerService.setResumeGate(() => true);
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(2));
        expect(fixture.tcp).not.toHaveBeenCalled();
    });
    it('ignores old datagrams/close callbacks after an explicit stop and new session', async () => {
        NmeaListenerService.start();
        await settle();
        const old = fixture.sessions[0];
        NmeaListenerService.stop();
        NmeaListenerService.start();
        await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(2));
        old.options.onSentence('$GPVTG,45,T,,M,5,N,9.26,K,D', Date.now());
        old.options.onClosed('receive-failed');
        expect(NmeaListenerService.getStatus()).toBe('connecting');
        expect(fixture.sessions[1].stop).not.toHaveBeenCalled();
        fixture.sessions[1].options.onSentence('$GPVTG,90,T,,M,3,N,5.556,K,D', Date.now());
        expect(NmeaListenerService.getStatus()).toBe('connected');
    });
    it('retires a silent listener and does not reopen while the resume policy refuses it', async () => {
        NmeaListenerService.start();
        await settle();
        NmeaListenerService.setResumeGate(() => false);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(fixture.sessions[0].stop).toHaveBeenCalled();
        expect(NmeaListenerService.getStatus()).not.toBe('connected');
        expect(NmeaListenerService.getLastError()).toContain('No unicast UDP sentences received');
        expect(fixture.open).toHaveBeenCalledTimes(1);
        expect(fixture.tcp).not.toHaveBeenCalled();
    });
});
