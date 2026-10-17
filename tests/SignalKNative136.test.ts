import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    platform: 'ios',
    request: vi.fn(),
    cancel: vi.fn(async () => undefined),
    start: vi.fn(
        async (_options: {
            sessionId: string;
            origin: string;
            allowInsecureLan: boolean;
            accessToken: string;
        }): Promise<void> => undefined,
    ),
    stop: vi.fn(async () => undefined),
    handlers: new Map<string, (event: unknown) => void>(),
    removed: [] as string[],
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => f.platform },
    registerPlugin: () => ({
        request: f.request,
        cancel: f.cancel,
        start: f.start,
        stop: f.stop,
        addListener: async (name: string, handler: (event: unknown) => void) => {
            f.handlers.set(name, handler);
            return {
                remove: async () => {
                    f.removed.push(name);
                    f.handlers.delete(name);
                },
            };
        },
    }),
}));
import { openSignalKNative, signalKNativeRequest } from '../services/signalk/native';
const config = {
    origin: 'https://boat.example',
    clientId: '12345678-1234-4321-8765-123456789012',
    allowInsecureLan: false,
    selected: true,
};
const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    f.platform = 'ios';
    f.handlers.clear();
    f.removed = [];
    f.start.mockResolvedValue(undefined);
    f.request.mockResolvedValue({ status: 200, body: '{}' });
});
afterEach(() => vi.useRealTimers());
describe('native direct reader boundary', () => {
    it('does not create a web socket/HTTP substitute on the web', async () => {
        f.platform = 'web';
        await expect(signalKNativeRequest(config, 'self', { accessToken: 'synthetic' })).rejects.toThrow('iPhone');
        const stream = openSignalKNative(
            config,
            'synthetic',
            () => undefined,
            () => undefined,
        );
        await expect(stream.ready).rejects.toThrow('iPhone');
        expect(f.request).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
    });
    it('uses fixed target/config and request cancellation without passing a caller URL path', async () => {
        const controller = new AbortController();
        let resolve!: (v: { status: number; body: string }) => void;
        f.request.mockImplementation(() => new Promise((r) => (resolve = r)));
        const read = signalKNativeRequest(config, 'self', { accessToken: 'synthetic', signal: controller.signal });
        await settle();
        expect(f.request.mock.calls[0][0]).toMatchObject({
            target: 'self',
            origin: config.origin,
            accessToken: 'synthetic',
        });
        expect(f.request.mock.calls[0][0]).not.toHaveProperty('url');
        controller.abort();
        expect(f.cancel).toHaveBeenCalled();
        resolve({ status: 200, body: '{}' });
        await expect(read).rejects.toThrow('unavailable');
    });
    it('removes session listeners and discards callbacks after stop', async () => {
        const onMessage = vi.fn(),
            onClosed = vi.fn(),
            stream = openSignalKNative(config, 'synthetic', onMessage, onClosed);
        await stream.ready;
        const id = f.start.mock.calls[0][0].sessionId;
        const message = f.handlers.get('message')!;
        message({ sessionId: 'old', text: '{}' });
        expect(onMessage).not.toHaveBeenCalled();
        message({ sessionId: id, text: '{}' });
        expect(onMessage).toHaveBeenCalledOnce();
        stream.stop();
        message({ sessionId: id, text: '{}' });
        expect(onMessage).toHaveBeenCalledOnce();
        expect(f.removed.sort()).toEqual(['closed', 'message']);
        expect(f.stop).toHaveBeenCalledWith({ sessionId: id });
    });
    it('times out a hung start and stops its late native completion by the same session ID', async () => {
        let resolve!: () => void;
        f.start.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
        const stream = openSignalKNative(
            config,
            'synthetic',
            () => undefined,
            () => undefined,
        );
        const rejected = expect(stream.ready).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(10001);
        await rejected;
        const id = f.start.mock.calls[0][0].sessionId;
        resolve();
        await settle();
        expect(f.stop).toHaveBeenCalledWith({ sessionId: id });
        expect(f.removed.sort()).toEqual(['closed', 'message']);
    });
    it('refuses oversized bridge events and only closes its own session', async () => {
        const onMessage = vi.fn(),
            onClosed = vi.fn(),
            stream = openSignalKNative(config, 'synthetic', onMessage, onClosed);
        await stream.ready;
        const id = f.start.mock.calls[0][0].sessionId;
        f.handlers.get('message')!({ sessionId: id, text: 'x'.repeat(65537) });
        expect(onMessage).not.toHaveBeenCalled();
        expect(onClosed).toHaveBeenCalledOnce();
        expect(f.stop).toHaveBeenCalledWith({ sessionId: id });
    });
});
