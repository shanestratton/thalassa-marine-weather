import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const native = vi.hoisted(() => ({
    platform: 'ios',
    listeners: new Map<string, Set<(event: unknown) => void>>(),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    removed: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => native.platform },
    registerPlugin: () => ({
        start: native.start,
        stop: native.stop,
        addListener: async (name: string, callback: (event: unknown) => void) => {
            const callbacks = native.listeners.get(name) ?? new Set();
            callbacks.add(callback);
            native.listeners.set(name, callbacks);
            return {
                remove: async () => {
                    callbacks.delete(callback);
                    native.removed();
                },
            };
        },
    }),
}));
import { openUdpTransport, udpSentences, validUnicastGateway } from '../services/nmea/udpTransport';

beforeEach(() => {
    vi.clearAllMocks();
    native.listeners.clear();
    native.platform = 'ios';
    native.start.mockImplementation(async (options: { sessionId: string }) => ({
        sessionId: options.sessionId,
        localAddress: '192.168.50.2',
    }));
});
const emit = (name: string, event: unknown) => {
    for (const callback of native.listeners.get(name) ?? []) callback(event);
};

describe('unicast UDP packet boundary', () => {
    it('accepts numeric unicast addresses and refuses multicast, broadcast, DNS, loopback and malformed input', () => {
        expect(validUnicastGateway('192.168.50.1')).toBe(true);
        expect(validUnicastGateway('169.254.1.10')).toBe(true);
        for (const host of [
            '224.0.0.1',
            '239.1.2.3',
            '255.255.255.255',
            '0.0.0.0',
            '127.0.0.1',
            '300.1.1.1',
            '192.168.01.1',
            'boat.local',
            ' 192.168.1.1',
            '192.168.1.1:10110',
        ])
            expect(validUnicastGateway(host)).toBe(false);
    });
    it('splits complete packets without joining another packet or accepting binary/unbounded data', () => {
        expect(udpSentences('$GPGLL,1\r\n$GPVTG,2\n')).toEqual(['$GPGLL,1', '$GPVTG,2']);
        expect(udpSentences('3,4\r\n')).toEqual([]);
        for (const value of ['\0$GPGLL,1', '$' + 'a'.repeat(16_385), '$GPGLL,1\n'.repeat(300), new Uint8Array([1])])
            expect(udpSentences(value)).toEqual([]);
    });
});
describe('native UDP bridge lifecycle', () => {
    it('fences other sessions, preserves native receipt time and bounds bridge batches', async () => {
        const receive = vi.fn(),
            closed = vi.fn(),
            dropped = vi.fn();
        const connection = openUdpTransport({
            host: '192.168.50.1',
            port: 10110,
            onSentence: receive,
            onClosed: closed,
            onDropped: dropped,
        });
        await connection.ready;
        const id = native.start.mock.calls[0][0].sessionId;
        const at = Date.now() - 3000;
        emit('datagrams', { sessionId: 'old', packets: [{ text: '$GPGLL,1', at }] });
        emit('datagrams', { sessionId: id, packets: [{ text: '$GPGLL,1\r\n$GPVTG,2', at }], dropped: 5 });
        expect(receive.mock.calls).toEqual([
            ['$GPGLL,1', at],
            ['$GPVTG,2', at],
        ]);
        expect(dropped).toHaveBeenCalledWith(5);
        emit('datagrams', {
            sessionId: id,
            packets: [
                { text: '$GPGLL,stale', at: Date.now() - 14000 },
                { text: '$GPGLL,future', at: Date.now() + 60000 },
            ],
        });
        emit('datagrams', { sessionId: id, packets: new Array(65).fill({ text: '$GPGLL,1', at }) });
        expect(receive).toHaveBeenCalledTimes(2);
        connection.stop();
        emit('datagrams', { sessionId: id, packets: [{ text: '$GPGLL,late', at }] });
        expect(receive).toHaveBeenCalledTimes(2);
        expect(native.removed).toHaveBeenCalledTimes(2);
        expect(native.stop).toHaveBeenCalledWith({ sessionId: id });
        expect(closed).not.toHaveBeenCalled();
    });
    it('stops a late start result and never exposes data after cancellation', async () => {
        let complete!: (value: { sessionId: string; localAddress: string }) => void;
        native.start.mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const receive = vi.fn();
        const connection = openUdpTransport({
            host: '192.168.50.1',
            port: 10110,
            onSentence: receive,
            onClosed: vi.fn(),
        });
        await vi.waitFor(() => expect(native.start).toHaveBeenCalled());
        const id = native.start.mock.calls[0][0].sessionId;
        connection.stop();
        complete({ sessionId: id, localAddress: '192.168.50.2' });
        await connection.ready;
        expect(native.stop).toHaveBeenCalledWith({ sessionId: id });
        expect(receive).not.toHaveBeenCalled();
    });
    it('reports native close once and removes both listeners', async () => {
        const closed = vi.fn();
        const connection = openUdpTransport({
            host: '192.168.50.1',
            port: 10110,
            onSentence: vi.fn(),
            onClosed: closed,
        });
        await connection.ready;
        const id = native.start.mock.calls[0][0].sessionId;
        emit('state', { sessionId: id, reason: 'background' });
        emit('state', { sessionId: id, reason: 'background' });
        expect(closed).toHaveBeenCalledExactlyOnceWith('background');
        expect(native.removed).toHaveBeenCalledTimes(2);
    });
    it('has an honest web unavailable result and does not open a TCP/WebSocket substitute', async () => {
        native.platform = 'web';
        const connection = openUdpTransport({
            host: '192.168.50.1',
            port: 10110,
            onSentence: vi.fn(),
            onClosed: vi.fn(),
        });
        await expect(connection.ready).rejects.toThrow('iPhone or iPad');
        expect(native.start).not.toHaveBeenCalled();
        connection.stop();
    });
    it('dispatches nonblocking receive off the Capacitor queue and registers exactly one native source', () => {
        const swift = readFileSync('ios/App/App/NmeaUdpPlugin.swift', 'utf8');
        expect(swift).toContain('DispatchQueue(label: "com.thalassa.nmea.unicast"');
        expect(swift).toContain('queue.async');
        expect(swift).toContain('O_NONBLOCK');
        expect(swift).toContain('makeReadSource');
        expect(swift).toContain('sender.sin_addr.s_addr != gateway.s_addr');
        expect(swift).toContain('didEnterBackgroundNotification');
        expect(swift).not.toMatch(/IP_ADD_MEMBERSHIP|SO_BROADCAST|SO_REUSEPORT/);
        const project = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
        expect(project.match(/path = NmeaUdpPlugin.swift;/g)).toHaveLength(1);
        expect(project.match(/NmeaUdpPlugin.swift in Sources \*\//g)).toHaveLength(2);
        expect(readFileSync('ios/App/App/ThalassaBridgeViewController.swift', 'utf8')).toContain(
            'registerPluginInstance(NmeaUdpPlugin())',
        );
    });
});
