import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decodeLocalRasterInWorker,
    type LocalRasterWorker,
    validateLocalRasterReply,
} from '../services/charts/localRasterWorkerHost';

class DecoderWorker implements LocalRasterWorker {
    onmessage: LocalRasterWorker['onmessage'] = null;
    onerror: LocalRasterWorker['onerror'] = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    reply(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data }));
    }
    id() {
        return (this.postMessage.mock.calls[0][0] as { id: number }).id;
    }
}
const output = () => ({
    width: 1,
    height: 1,
    rgba: new Uint8Array([200, 50, 30, 255]),
    bounds: [150, -27, 151, -26],
    datum: 'WGS84',
    sourceProjection: 'EPSG:4326',
    note: 'Fictional protocol fixture only.',
});
beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});
describe('local raster worker lifetime and reply admission', () => {
    it('waits for actual readiness before one bounded transferable and cleans up without cancelling a successful caller', async () => {
        const worker = new DecoderWorker(),
            controller = new AbortController(),
            buffer = new ArrayBuffer(8);
        const promise = decodeLocalRasterInWorker('kap', buffer, {
            signal: controller.signal,
            workerFactory: () => worker,
        });
        expect(worker.postMessage).not.toHaveBeenCalled();
        worker.reply({ type: 'ready' });
        worker.reply({ type: 'ready' });
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(worker.postMessage.mock.calls[0][1]).toEqual([buffer]);
        worker.reply({ type: 'decoded', id: worker.id(), image: output() });
        expect((await promise).rgba).toEqual(output().rgba);
        expect(controller.signal.aborted).toBe(false);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.onmessage).toBeNull();
    });
    it('does not construct a worker or transfer bytes for an already retired request', async () => {
        const factory = vi.fn(() => new DecoderWorker());
        await expect(
            decodeLocalRasterInWorker('kap', new ArrayBuffer(8), { isCurrent: () => false, workerFactory: factory }),
        ).rejects.toThrow('stopped');
        expect(factory).not.toHaveBeenCalled();
    });
    it('terminates on abort before readiness and refuses a retained late message', async () => {
        const worker = new DecoderWorker(),
            controller = new AbortController();
        const promise = decodeLocalRasterInWorker('tif', new ArrayBuffer(8), {
            signal: controller.signal,
            workerFactory: () => worker,
        }).catch((error: unknown) => error);
        const late = worker.onmessage!;
        controller.abort();
        late(new MessageEvent('message', { data: { type: 'ready' } }));
        expect(await promise).toBeInstanceOf(Error);
        expect(worker.postMessage).not.toHaveBeenCalled();
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
    it('retires an in-flight worker after A/B/A-style source generation loss', async () => {
        let live = true;
        const worker = new DecoderWorker();
        const promise = decodeLocalRasterInWorker('kap', new ArrayBuffer(8), {
            isCurrent: () => live,
            workerFactory: () => worker,
        }).catch((error: unknown) => error);
        worker.reply({ type: 'ready' });
        live = false;
        await vi.advanceTimersByTimeAsync(50);
        expect(await promise).toBeInstanceOf(Error);
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
    it('holds a never-ready worker at the real 15-second ceiling', async () => {
        const worker = new DecoderWorker();
        const promise = decodeLocalRasterInWorker('tiff', new ArrayBuffer(8), { workerFactory: () => worker }).catch(
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(15_000);
        expect(((await promise) as Error).message).toContain('15 seconds');
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
    it.each([
        { width: 1025 },
        { rgba: new Uint8Array(3) },
        { bounds: [150, -90, 151, -26] },
        { datum: 'NAD83' },
        { sourceProjection: 'guessed' },
        { note: 'x'.repeat(301) },
    ])('refuses malformed actual reply structure: %j', (changed) => {
        expect(() => validateLocalRasterReply({ ...output(), ...changed })).toThrow();
    });
    it('does not accept an uncorrelated response or silently run a page-thread decoder', async () => {
        const worker = new DecoderWorker();
        const promise = decodeLocalRasterInWorker('kap', new ArrayBuffer(8), { workerFactory: () => worker }).catch(
            (error: unknown) => error,
        );
        worker.reply({ type: 'ready' });
        worker.reply({ type: 'decoded', id: worker.id() + 1, image: output() });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await promise).toBeInstanceOf(Error);
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
    it('preserves the concrete decoder rejection and terminates on worker/CSP errors', async () => {
        const worker = new DecoderWorker();
        const promise = decodeLocalRasterInWorker('kap', new ArrayBuffer(8), { workerFactory: () => worker }).catch(
            (error: unknown) => error,
        );
        worker.reply({ type: 'ready' });
        worker.reply({ type: 'error', id: worker.id(), message: 'Unsupported original datum.' });
        expect(((await promise) as Error).message).toBe('Unsupported original datum.');
        const second = new DecoderWorker();
        const failed = decodeLocalRasterInWorker('tif', new ArrayBuffer(8), { workerFactory: () => second }).catch(
            (error: unknown) => error,
        );
        second.onerror?.(new ErrorEvent('error'));
        expect(((await failed) as Error).message).toContain('blocked');
        expect(second.terminate).toHaveBeenCalledOnce();
    });
});
