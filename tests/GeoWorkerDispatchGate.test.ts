/**
 * One geometry job in the worker at a time.
 *
 * Shane's 2026-08-23 trail, the first ever taken on this path (it had zero
 * crumbs before that day):
 *
 *   enc:geo-dispatch(#1 2glaze/3178snd w10930 inflight1)
 *   enc:geo-dispatch(#2 0glaze/3178snd w0    inflight2)
 *
 * Two jobs in the worker together, each structured-cloning 3 178 soundings.
 * Nothing gated it — merges finish while the previous upgrade is still
 * running — and EVERY bound in geometryUpgrades is a per-job bound, so N
 * concurrent jobs multiply all of them at once.
 *
 * It matters more here than it would elsewhere: on Chrome a dedicated worker
 * is a thread in the SAME renderer process, and its heap is invisible to
 * performance.memory in both directions. A second concurrent payload is
 * memory the crash census cannot see by construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWorker {
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    terminate: ReturnType<typeof vi.fn>;
}
let worker: FakeWorker;

/** A merge with enough soundings to earn a contour job, and nothing else. */
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
    // Same reason as tests/enc/geometryUpgrades.test.ts: the gate is being
    // tested, not the experiment that currently drops the glaze half.
    geo.setGlazeClipExperimentOff(false);
    const cache = await import('../services/enc/mergedDataCache');
    return { geo, cache };
}

/** Post a merge into the cache so the deferred drain sees it as still live. */
function seed(cache: Awaited<ReturnType<typeof loadModules>>['cache'], key: string, merged: unknown) {
    cache.putMergedData(key, merged as never, [{ id: `cell-${key}`, sizeBytes: 1000 }]);
}

beforeEach(() => {
    vi.unstubAllGlobals();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the dispatch gate', () => {
    it('posts the first job and HOLDS the second', async () => {
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        const b = fakeMerge();
        seed(cache, 'A', a);
        seed(cache, 'B', b);

        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(geo.geoDispatchGateState()).toEqual({ busy: true, queued: 0 });

        geo.dispatchGeometryWork('B', b as never, true, [], [], undefined);
        // THE FIX: still one payload in the worker, not two.
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(geo.geoDispatchGateState()).toEqual({ busy: true, queued: 1 });
    });

    it('releases the held job when the worker replies', async () => {
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        const b = fakeMerge();
        seed(cache, 'A', a);
        seed(cache, 'B', b);

        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', b as never, true, [], [], undefined);
        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;

        worker.onmessage?.({ data: { type: 'done', jobId } });

        expect(worker.postMessage).toHaveBeenCalledTimes(2);
        expect(geo.geoDispatchGateState()).toEqual({ busy: true, queued: 0 });
    });

    it('keeps only the LATEST held request — a queue of one', async () => {
        // A superseded merge's upgrade is worthless: the window has moved on.
        // Stacking them would reintroduce the problem one step later.
        const { geo, cache } = await loadModules();
        for (const k of ['A', 'B', 'C']) seed(cache, k, fakeMerge());

        geo.dispatchGeometryWork('A', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('C', fakeMerge() as never, true, [], [], undefined);
        expect(geo.geoDispatchGateState().queued).toBe(1);

        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;
        worker.onmessage?.({ data: { type: 'done', jobId } });
        // Two posts total: the first, then C. B never ships.
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('drops a held job whose merge was evicted while it waited', async () => {
        // It would clone a full payload to upgrade something no longer there.
        const { geo, cache } = await loadModules();
        const a = fakeMerge();
        seed(cache, 'A', a);
        geo.dispatchGeometryWork('A', a as never, true, [], [], undefined);
        geo.dispatchGeometryWork('GONE', fakeMerge() as never, true, [], [], undefined);

        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;
        worker.onmessage?.({ data: { type: 'done', jobId } });

        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(geo.geoDispatchGateState()).toEqual({ busy: false, queued: 0 });
    });

    it('opens on a worker error, not just on success', async () => {
        const { geo, cache } = await loadModules();
        seed(cache, 'A', fakeMerge());
        seed(cache, 'B', fakeMerge());
        geo.dispatchGeometryWork('A', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);

        const jobId = (worker.postMessage.mock.calls[0][0] as { jobId: number }).jobId;
        worker.onmessage?.({ data: { type: 'error', jobId, message: 'boom' } });
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('opens on a STRAGGLER done for a job it already forgot', async () => {
        // A stuck gate would silently disable every glaze and contour upgrade
        // for the rest of the session — a worse failure than the one it fixes.
        const { geo, cache } = await loadModules();
        seed(cache, 'A', fakeMerge());
        seed(cache, 'B', fakeMerge());
        geo.dispatchGeometryWork('A', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);

        worker.onmessage?.({ data: { type: 'done', jobId: 99999 } });
        expect(geo.geoDispatchGateState().busy).toBe(true);
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('never posts into a dead worker', async () => {
        const { geo, cache } = await loadModules();
        seed(cache, 'A', fakeMerge());
        seed(cache, 'B', fakeMerge());
        geo.dispatchGeometryWork('A', fakeMerge() as never, true, [], [], undefined);
        geo.dispatchGeometryWork('B', fakeMerge() as never, true, [], [], undefined);

        worker.onerror?.();
        expect(geo.geoDispatchGateState()).toEqual({ busy: false, queued: 0 });
        expect(geo.isGeoWorkerBroken()).toBe(true);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });
});
