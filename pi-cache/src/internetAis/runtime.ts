import type { InternetAisAuthority, InternetAisFix } from './publisher.js';
import { InternetAisPublisher } from './publisher.js';
import { createInternetAisTcp, internetAisEndpoint, internetAisFetcher } from './transport.js';

/** Import starts no listener. The only network output is an explicitly admitted local JSON feed. */
export function startInternetAisRuntime(options: {
    enabled: boolean;
    reviewed: boolean;
    port: number;
    blockedPorts: readonly number[];
    supabaseOrigin: string;
    authority(): InternetAisAuthority | null;
    fix(signal: AbortSignal): Promise<InternetAisFix | null>;
}) {
    if (!options.enabled || !options.reviewed) return null;
    if (
        !Number.isInteger(options.port) ||
        options.port < 1024 ||
        options.port > 65535 ||
        options.blockedPorts.includes(options.port)
    ) {
        console.warn('[internet-ais] Local JSON port is unavailable');
        return null;
    }
    let fetch: ReturnType<typeof internetAisFetcher>;
    try {
        fetch = internetAisFetcher(internetAisEndpoint(options.supabaseOrigin));
    } catch {
        console.warn('[internet-ais] Configured reader is unavailable');
        return null;
    }
    const publisher = new InternetAisPublisher({
        authority: options.authority,
        fix: options.fix,
        fetch,
        emit: (line, current) => tcp.emit(line, current),
        retire: () => tcp.retire(),
    });
    const tcp = createInternetAisTcp({ beforeClient: () => !!publisher.refresh() });
    publisher.refresh();
    let lastPoll = -Infinity;
    const timer = setInterval(() => {
        publisher.refresh();
        const now = Date.now();
        if (tcp.clients() && (now < lastPoll || now - lastPoll >= 30_000)) {
            lastPoll = now;
            void publisher.poll();
        }
    }, 1000);
    timer.unref();
    const close = () => {
        clearInterval(timer);
        publisher.close();
        tcp.close();
    };
    tcp.server.on('error', () => {
        close();
        console.warn('[internet-ais] Local JSON listener unavailable');
    });
    try {
        tcp.server.listen(options.port, '127.0.0.1');
    } catch {
        close();
        return null;
    }
    return { close, refresh: () => publisher.refresh(), server: tcp.server };
}
