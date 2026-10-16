import { Client, WebSocket } from 'undici';
import { createSignalKClient } from './signalKClient.js';
import {
    SIGNALK_READ_PATHS,
    SignalKReadState,
    type SignalKNotice,
    type SignalKNoticeEvent,
} from './signalkProtocol.js';

export type SignalKStreamState = 'connecting' | 'reading' | 'disconnected' | 'stopped';
/** Fixed-origin, receive-only stream. The operator owns origin/token; callers cannot send commands. */
export function startSignalKReadStream(options: {
    origin: string;
    accessToken?: string;
    allowInsecureLan?: boolean;
    selfUrn: string;
    onDocument: (document: Record<string, unknown>) => void;
    onNotifications?: (active: SignalKNotice[], events: SignalKNoticeEvent[]) => void;
    onState?: (state: SignalKStreamState) => void;
}): { stop(): void } {
    // Reuse exactly the reviewed HTTP origin/token validation; no discovery URL can redirect credentials.
    const { origin } = createSignalKClient(options);
    const state = new SignalKReadState(options.selfUrn);
    const dispatcher = new Client(origin, {
        webSocket: { maxPayloadSize: 65_536, maxFragments: 32 },
        connectTimeout: 10_000,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
    });
    const url = new URL('/signalk/v1/stream?subscribe=none', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, {
        dispatcher,
        headers: options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {},
    });
    let stopped = false,
        closed = false,
        reading = false,
        lastMessage = Date.now();
    let windowAt = Date.now(),
        messages = 0,
        bytes = 0;
    const emit = (next: SignalKStreamState) => {
        try {
            options.onState?.(next);
        } catch {
            /* consumer cannot retain a failed socket */
        }
    };
    const shutdown = (next: 'stopped' | 'disconnected') => {
        if (closed) return;
        closed = true;
        clearInterval(watchdog);
        state.clear();
        try {
            ws.close(1000);
        } catch {
            /* handshake may not have completed */
        }
        void dispatcher.destroy().catch(() => undefined);
        try {
            options.onNotifications?.([], []);
        } catch {
            /* source retired */
        }
        emit(next);
    };
    const watchdog = setInterval(() => {
        if (Date.now() - lastMessage > (reading ? 30_000 : 10_000)) shutdown('disconnected');
    }, 1000);
    watchdog.unref();
    emit('connecting');
    ws.addEventListener('open', () => {
        if (closed || stopped) return shutdown('stopped');
        // Exact allowlist; no vessel wildcard and no arbitrary app-supplied paths/periods.
        const paths = [
            ...SIGNALK_READ_PATHS,
            'propulsion.*.revolutions',
            'propulsion.*.runTime',
            'propulsion.*.coolantTemperature',
            'propulsion.*.oilPressure',
            'notifications.*',
        ];
        ws.send(
            JSON.stringify({
                context: 'vessels.self',
                subscribe: paths.map((path) => ({ path, period: 1000, policy: 'instant', minPeriod: 1000 })),
            }),
        );
        reading = true;
        lastMessage = Date.now();
        emit('reading');
    });
    ws.addEventListener('message', (event) => {
        if (closed || stopped) return;
        const now = Date.now();
        if (typeof event.data !== 'string' || event.data.length > 65_536) return shutdown('disconnected');
        if (now - windowAt >= 1000) {
            windowAt = now;
            messages = 0;
            bytes = 0;
        }
        messages++;
        bytes += Buffer.byteLength(event.data, 'utf8');
        if (messages > 64 || bytes > 262_144) return shutdown('disconnected');
        lastMessage = now;
        let data: unknown;
        try {
            data = JSON.parse(event.data);
        } catch {
            return shutdown('disconnected');
        }
        const result = state.ingestDelta(data, now);
        try {
            if (result.changed) options.onDocument(state.document());
            options.onNotifications?.(state.notifications(now), result.notices);
        } catch {
            shutdown('disconnected');
        }
    });
    ws.addEventListener('error', () => shutdown(stopped ? 'stopped' : 'disconnected'));
    ws.addEventListener('close', () => shutdown(stopped ? 'stopped' : 'disconnected'));
    return {
        stop() {
            stopped = true;
            shutdown('stopped');
        },
    };
}
