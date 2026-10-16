import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SignalKDeviceConfig } from './config';
interface SignalKBridge {
    request(options: {
        requestId: string;
        origin: string;
        allowInsecureLan: boolean;
        target: 'discovery' | 'self' | 'access' | 'accessStatus';
        clientId?: string;
        accessId?: string;
        accessToken?: string;
    }): Promise<{ status: number; body: string }>;
    cancel(options: { requestId: string }): Promise<void>;
    start(options: {
        sessionId: string;
        origin: string;
        allowInsecureLan: boolean;
        accessToken: string;
    }): Promise<void>;
    stop(options: { sessionId: string }): Promise<void>;
    addListener(name: 'message' | 'closed', callback: (event: unknown) => void): Promise<PluginListenerHandle>;
}
let held: SignalKBridge | undefined;
const bridge = () => (held ??= registerPlugin<SignalKBridge>('SignalKReader'));
async function deadline<T>(work: Promise<T>, cancel: () => void, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    cancel();
                    reject(new Error('Signal K transport timed out'));
                }, ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
export const nativeSignalKAvailable = () => Capacitor.getPlatform() === 'ios';
export async function signalKNativeRequest(
    config: SignalKDeviceConfig,
    target: 'discovery' | 'self' | 'access' | 'accessStatus',
    options: { accessId?: string; accessToken?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; body: unknown }> {
    if (!nativeSignalKAvailable()) throw new Error('Direct Signal K needs the iPhone or iPad app');
    const requestId = crypto.randomUUID();
    const cancel = () =>
        void bridge()
            .cancel({ requestId })
            .catch(() => undefined);
    if (options.signal?.aborted) throw new Error('Signal K request cancelled');
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
        const reply = await deadline(
            bridge().request({
                requestId,
                origin: config.origin,
                allowInsecureLan: config.allowInsecureLan,
                target,
                clientId: config.clientId,
                accessId: options.accessId,
                accessToken: options.accessToken,
            }),
            cancel,
            16000,
        );
        if (options.signal?.aborted) throw new Error('Signal K request cancelled');
        if (
            !Number.isInteger(reply.status) ||
            typeof reply.body !== 'string' ||
            reply.body.length > (target === 'self' ? 1_048_576 : 65_536)
        )
            throw new Error('Invalid Signal K response');
        return { status: reply.status, body: reply.body ? JSON.parse(reply.body) : null };
    } catch {
        throw new Error('Signal K request unavailable');
    } finally {
        options.signal?.removeEventListener('abort', cancel);
    }
}
export function openSignalKNative(
    config: SignalKDeviceConfig,
    accessToken: string,
    onMessage: (text: string) => void,
    onClosed: () => void,
): { ready: Promise<void>; stop(): void } {
    const sessionId = crypto.randomUUID(),
        handles: PluginListenerHandle[] = [];
    let active = true;
    const stop = () => {
        if (!active) return;
        active = false;
        for (const h of handles) void h.remove();
        if (held) void held.stop({ sessionId }).catch(() => undefined);
    };
    const work = (async () => {
        if (!nativeSignalKAvailable()) throw new Error('Direct Signal K needs the iPhone or iPad app');
        for (const name of ['message', 'closed'] as const) {
            const h = await bridge().addListener(name, (e) => {
                if (!active || !e || typeof e !== 'object') return;
                const v = e as Record<string, unknown>;
                if (v.sessionId !== sessionId) return;
                if (name === 'closed') {
                    stop();
                    onClosed();
                    return;
                }
                if (typeof v.text !== 'string' || v.text.length > 65536) {
                    stop();
                    onClosed();
                    return;
                }
                onMessage(v.text);
            });
            if (!active) {
                void h.remove();
                return;
            }
            handles.push(h);
        }
        try {
            await bridge().start({
                sessionId,
                origin: config.origin,
                allowInsecureLan: config.allowInsecureLan,
                accessToken,
            });
        } catch {
            stop();
            throw new Error('Signal K stream unavailable');
        }
        if (!active)
            void bridge()
                .stop({ sessionId })
                .catch(() => undefined);
    })();
    const ready = deadline(work, stop, 10000);
    return { ready, stop };
}
