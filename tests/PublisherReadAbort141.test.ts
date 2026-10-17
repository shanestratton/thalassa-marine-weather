import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBoundedPublisherBytes, readBoundedResponse } from '../services/weather/api/cmemsGridTrust';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('bounded publisher reads keep ownership through cancellation', () => {
    it('retires a never-resolving read even when its cancel hook never resolves', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const body = new ReadableStream<Uint8Array>({ cancel });
        const controller = new AbortController();
        const result = readBoundedResponse(new Response(body), 16, controller.signal);
        const held = expect(result).rejects.toThrow('retired owner');
        controller.abort(new Error('retired owner'));
        await held;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
    });

    it('preserves ordinary awaited cancellation then lets an abort break only the stalled wait', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array(17));
            },
            cancel,
        });
        const controller = new AbortController();
        let done = false;
        const result = readBoundedResponse(new Response(body), 16, controller.signal).finally(() => {
            done = true;
        });
        const held = expect(result).rejects.toThrow('deadline');
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        expect(done).toBe(false);
        controller.abort(new Error('deadline'));
        await held;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
    });

    it('uses the shared 45-second controller deadline for an abort-ignoring stream', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(new ReadableStream<Uint8Array>({ cancel }), {
                        headers: { 'content-type': 'application/octet-stream' },
                    }),
            ),
        );
        const result = fetchBoundedPublisherBytes('/api/atmos/fixture.bin', 16, 'application/octet-stream');
        const held = expect(result).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(45_000);
        await held;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not abort or invalidate a successful read during finally cleanup', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let fetchSignal: AbortSignal | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, options: RequestInit) => {
                fetchSignal = options.signal as AbortSignal;
                return new Response(new Uint8Array([1, 2, 3]), {
                    headers: { 'content-type': 'application/octet-stream' },
                });
            }),
        );
        const bytes = await fetchBoundedPublisherBytes(
            '/api/atmos/fixture.bin',
            16,
            'application/octet-stream',
            controller.signal,
        );
        expect([...bytes]).toEqual([1, 2, 3]);
        expect(fetchSignal?.aborted).toBe(false);
        expect(controller.signal.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('observes a rejecting cancel hook without replacing the caller abort reason', async () => {
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                return Promise.reject(new Error('upstream cleanup rejected'));
            },
        });
        const controller = new AbortController();
        const result = readBoundedResponse(new Response(body), 16, controller.signal);
        const held = expect(result).rejects.toThrow('owner closed');
        controller.abort(new Error('owner closed'));
        await held;
        expect(body.locked).toBe(false);
    });
});
