/**
 * Kill #29 (2026-08-25, hours after kill #28's output sanitizer): a
 * geometry-worker job that HANGS never fires onerror, so the 2026-07-13
 * "worker died → fast glaze for the session" response never engages. The
 * desktop trail showed job #1 running 100+ seconds without a reply before
 * the renderer died; the phone died ~10 s after its dispatch, no reply, no
 * geo-done. The worker's heap is invisible to every gauge, so the only
 * honest bound is time: no job may run past its deadline.
 *
 * The watchdog terminates the hung worker (reclaiming the runaway thread's
 * heap — the part a hang uniquely needs) and routes through the exact
 * funeral onerror uses: fast glaze for the session, nothing left waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWorker {
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    terminate: ReturnType<typeof vi.fn>;
}
let worker: FakeWorker;

function fakeMerge(n = 12) {
    const features = Array.from({ length: n }, (_, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [150 + i * 0.01, -23 - i * 0.01] },
        properties: { _d: 10 + i },
    }));
    return {
        SOUNDG: { type: 'FeatureCollection', features },
        DEPCNT_DERIVED: { type: 'FeatureCollection', features: [] },
        DEPARE_GLAZE: { type: 'FeatureCollection', features: [] },
        cellCount: 1,
    };
}

async function loadModules() {
    vi.resetModules();
    worker = {
        postMessage: vi.fn(),
        onmessage: null,
        onerror: null,
        terminate: vi.fn(),
    };
    vi.stubGlobal(
        'Worker',
        class {
            constructor() {
                return worker as unknown as Worker;
            }
        },
    );
    const geo = await import('../services/enc/geometryUpgrades');
    geo.setGlazeClipExperimentOff(false);
    const cache = await import('../services/enc/mergedDataCache');
    return { geo, cache };
}

function seed(cache: Awaited<ReturnType<typeof loadModules>>['cache'], key: string, merged: unknown) {
    cache.putMergedData(key, merged as never, [{ id: `cell-${key}`, sizeBytes: 1000 }]);
}

beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the geometry-job watchdog', () => {
    it('terminates a worker whose job never replies, and stands down for the session', async () => {
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        seed(cache, 'A', a);

        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(geo.geoDispatchGateState().busy).toBe(true);

        vi.advanceTimersByTime(20_000);

        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(geo.isGeoWorkerBroken()).toBe(true);
        // Nothing left waiting on a reply that will never come.
        expect(geo.geoDispatchGateState()).toEqual({ busy: false, queued: 0 });

        // And no further payloads ship this session — fast glaze stands.
        seed(cache, 'B', fakeMerge());
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    it('a mid-job reply is proof of life — the deadline resets', async () => {
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        seed(cache, 'A', a);

        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;

        vi.advanceTimersByTime(15_000);
        worker.onmessage?.({ data: { type: 'contours', jobId, features: [] } });
        vi.advanceTimersByTime(15_000); // 30 s since post, 15 s since last reply
        expect(worker.terminate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(6_000); // now past the fed deadline
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('a completed job never trips the watchdog', async () => {
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        seed(cache, 'A', a);

        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;
        worker.onmessage?.({ data: { type: 'done', jobId } });

        vi.advanceTimersByTime(60_000);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(geo.isGeoWorkerBroken()).toBe(false);
    });

    it('a held dispatch dies with the hung worker — no zombie hand-off', async () => {
        const { geo, cache } = await loadModules();
        seed(cache, 'A', fakeMerge());
        seed(cache, 'B', fakeMerge());

        geo.dispatchGeometryWork('A', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);
        expect(geo.geoDispatchGateState()).toEqual({ busy: true, queued: 1 });

        vi.advanceTimersByTime(20_000);
        // B is dropped, not posted into a replacement worker with the same
        // input class that just hung.
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(geo.geoDispatchGateState()).toEqual({ busy: false, queued: 0 });
    });
});
