import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface UdpBridge {
    start(options: {
        sessionId: string;
        host: string;
        port: number;
    }): Promise<{ sessionId: string; localAddress: string }>;
    stop(options: { sessionId: string }): Promise<void>;
    addListener(name: 'datagrams' | 'state', callback: (event: unknown) => void): Promise<PluginListenerHandle>;
}
export interface UdpTransport {
    ready: Promise<void>;
    stop(): void;
}
let bridge: UdpBridge | undefined;
const native = () => (bridge ??= registerPlugin<UdpBridge>('NmeaUdp'));

export function validUnicastGateway(host: string): boolean {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    const parts = host.split('.').map(Number);
    return (
        parts.every((part, i) => String(part) === host.split('.')[i] && part <= 255) &&
        parts[0] > 0 &&
        parts[0] < 224 &&
        parts[0] !== 127
    );
}

/** Datagrams remain separate. A truncated packet cannot complete another packet. */
export function udpSentences(text: unknown): string[] {
    if (typeof text !== 'string' || text.length > 16_384) return [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)) return [];
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 256) return [];
    return lines
        .map((line) => line.trim())
        .filter((line) => line.length <= 512 && (line.startsWith('$') || line.startsWith('!')));
}

export function openUdpTransport(options: {
    host: string;
    port: number;
    onSentence(sentence: string, receivedAt: number): void;
    onClosed(reason: string): void;
    onDropped?(count: number): void;
    onListening?(localAddress: string): void;
}): UdpTransport {
    const sessionId = crypto.randomUUID();
    let active = true;
    const handles: PluginListenerHandle[] = [];
    const stop = () => {
        if (!active) return;
        active = false;
        for (const handle of handles) void handle.remove();
        if (bridge) void bridge.stop({ sessionId }).catch(() => undefined);
    };
    const ready = (async () => {
        if (Capacitor.getPlatform() !== 'ios') throw new Error('Unicast UDP needs the iPhone or iPad app');
        if (
            !validUnicastGateway(options.host) ||
            !Number.isInteger(options.port) ||
            options.port < 1 ||
            options.port > 65535
        )
            throw new Error('Enter a unicast gateway IPv4 address and port');
        try {
            for (const [name, handler] of [
                [
                    'datagrams',
                    (event: unknown) => {
                        if (!active || !event || typeof event !== 'object') return;
                        const row = event as Record<string, unknown>;
                        if (row.sessionId !== sessionId || !Array.isArray(row.packets) || row.packets.length > 64)
                            return;
                        if (typeof row.dropped === 'number' && Number.isSafeInteger(row.dropped) && row.dropped > 0)
                            options.onDropped?.(row.dropped);
                        let bytes = 0;
                        for (const packet of row.packets) {
                            if (!packet || typeof packet !== 'object') continue;
                            const { at, text } = packet as Record<string, unknown>;
                            if (
                                typeof at !== 'number' ||
                                !Number.isFinite(at) ||
                                at <= 0 ||
                                at > Date.now() + 1000 ||
                                Date.now() - at > 13_000 ||
                                typeof text !== 'string'
                            )
                                continue;
                            bytes += text.length;
                            if (bytes > 65_536) break;
                            for (const sentence of udpSentences(text)) options.onSentence(sentence, Math.trunc(at));
                        }
                    },
                ],
                [
                    'state',
                    (event: unknown) => {
                        if (!active || !event || typeof event !== 'object') return;
                        const row = event as Record<string, unknown>;
                        if (row.sessionId !== sessionId) return;
                        stop();
                        options.onClosed(typeof row.reason === 'string' ? row.reason.slice(0, 64) : 'closed');
                    },
                ],
            ] as const) {
                const handle = await native().addListener(name, handler);
                if (!active) {
                    void handle.remove();
                    return;
                }
                handles.push(handle);
            }
            const starting = native().start({ sessionId, host: options.host, port: options.port });
            void starting.then(
                () => {
                    if (!active)
                        void native()
                            .stop({ sessionId })
                            .catch(() => undefined);
                },
                () => undefined,
            );
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const opened = await Promise.race([
                starting,
                new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error('UDP listener did not start within 10 seconds')),
                        10_000,
                    );
                }),
            ]).finally(() => {
                if (deadline) clearTimeout(deadline);
            });
            if (!active) {
                void native()
                    .stop({ sessionId })
                    .catch(() => undefined);
                return;
            }
            if (opened.sessionId !== sessionId) throw new Error('UDP session was replaced');
            if (!validUnicastGateway(opened.localAddress)) throw new Error('UDP Wi-Fi address unavailable');
            options.onListening?.(opened.localAddress);
        } catch (error) {
            stop();
            throw error;
        }
    })();
    return { ready, stop };
}
