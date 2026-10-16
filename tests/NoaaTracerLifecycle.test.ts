import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InshoreLayers } from '../services/inshoreRouterEngine';
const state = vi.hoisted(() => ({
    hold: null as Promise<void> | null,
    builds: 0,
    releases: 0,
    stale: false,
    failGrid: false,
    gradingDone: false,
}));
vi.mock('../services/InshoreRouter', () => ({
    assembleTracerLayers: async () => {
        const { reserveNoaaResident } = await import('../services/enc/EncCellStore');
        const lease = reserveNoaaResident(100_000);
        return {
            merged: {} as InshoreLayers,
            cellsUsed: ['US5SYN01'],
            gatePairs: [],
            gateChecksUnavailable: false,
            chartStructures: {},
            chartView: {
                check: () => {
                    if (state.stale) throw Error('Chart account/revision changed');
                },
                release: () => {
                    state.releases++;
                    lease.release();
                },
            },
        };
    },
}));
vi.mock('../services/engine/navGridWorkerHost', () => ({
    buildNavGridAsync: async () => {
        state.builds++;
        if (state.hold) await state.hold;
        if (state.failGrid) throw Error('Grid worker failed');
        return null;
    },
}));
vi.mock('../utils/heapGauge', () => ({ awaitHeapHeadroom: async () => {}, heapTag: () => '' }));
vi.mock('../services/enc/mergeSettle', () => ({ awaitMergeAbortCooldown: async () => {} }));
vi.mock('../services/lowBridges', () => ({ loadLowBridges: async () => [] }));
import { noaaResidentBytes, setBlobCachePlottingMode } from '../services/enc/EncCellStore';
import {
    buildTracerContext,
    holdTracerCtx,
    setTracerCtxLru,
    tracerContextCurrent,
    validateTraceLeg,
    snapTraceTapToLead,
    snapTraceTapToWater,
    fixLegOnGrid,
    type TracerContext,
} from '../services/routeTracer';
import { gradeLegs } from '../services/traceGrading';
const box: [number, number, number, number] = [-30, 40, -29.98, 40.02];
const build = () => buildTracerContext(box, 2, { airDraftM: null });
beforeEach(() => {
    Object.assign(state, { hold: null, builds: 0, releases: 0, stale: false, failGrid: false, gradingDone: false });
    setBlobCachePlottingMode(false);
});
afterEach(() => expect(noaaResidentBytes()).toBe(0));

it('coalesced callers have separate idempotent ownership through the real grid await', async () => {
    let finish!: () => void;
    state.hold = new Promise<void>((r) => (finish = r));
    const a = build(),
        b = build();
    await vi.waitFor(() => expect(state.builds).toBe(1));
    expect(noaaResidentBytes()).toBe(100_000);
    finish();
    const [first, second] = await Promise.all([a, b]);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (!('ctx' in first) || !('ctx' in second)) throw Error('Missing context');
    expect(first.ctx).toBe(second.ctx);
    first.release?.();
    first.release?.();
    expect(noaaResidentBytes()).toBe(100_000);
    expect(tracerContextCurrent(second.ctx)).toBe(true);
    second.release?.();
    expect(state.releases).toBe(1);
    expect(tracerContextCurrent(second.ctx)).toBe(false);
});

it('LRU ownership survives caller release, then eviction/reset releases only the cache owner', async () => {
    const result = await build();
    if (!('ctx' in result)) throw Error('Missing context');
    let lru = holdTracerCtx([], result.ctx);
    result.release?.();
    expect(noaaResidentBytes()).toBe(100_000);
    // A synchronous UI reference to the same LRU item is not a second cache.
    lru = setTracerCtxLru(lru, lru);
    const ordinary = (n: number) => ({ grid: { cells: new Uint8Array(n) } }) as unknown as TracerContext;
    lru = holdTracerCtx(lru, ordinary(1));
    lru = holdTracerCtx(lru, ordinary(2));
    expect(noaaResidentBytes()).toBe(100_000);
    lru = holdTracerCtx(lru, ordinary(3));
    expect(lru).toHaveLength(3);
    expect(noaaResidentBytes()).toBe(0);
    expect(setTracerCtxLru(lru, [])).toEqual([]);
    expect(state.releases).toBe(1);
});

it('a stale context cannot grade, snap or fix and its LRU owner is discarded', async () => {
    const result = await build();
    if (!('ctx' in result)) throw Error('Missing context');
    let lru = holdTracerCtx([], result.ctx);
    result.release?.();
    state.stale = true;
    const a = { lat: 40, lon: -30 },
        b = { lat: 40.001, lon: -29.999 };
    expect(validateTraceLeg(a, b, result.ctx)).toMatchObject({ grade: 'caution', unchecked: true, minDepthM: null });
    expect(snapTraceTapToLead(result.ctx, a)).toBeNull();
    expect(snapTraceTapToWater(result.ctx, a)).toBeNull();
    expect(fixLegOnGrid(result.ctx, a, b)).toBeNull();
    lru = setTracerCtxLru(lru, lru);
    expect(lru).toEqual([]);
    expect(state.releases).toBe(1);
});

it.each(['failure', 'stale'] as const)('does not leak a package when the grid finishes with %s', async (mode) => {
    let finish!: () => void;
    state.hold = new Promise<void>((r) => (finish = r));
    const result = build();
    await vi.waitFor(() => expect(state.builds).toBe(1));
    if (mode === 'failure') state.failGrid = true;
    else state.stale = true;
    expect(noaaResidentBytes()).toBe(100_000);
    const refused = expect(result).rejects.toThrow(mode === 'failure' ? 'Grid worker' : 'revision');
    finish();
    await refused;
    expect(state.releases).toBe(1);
});

it.each(['one-shot', 'superseded', 'callback failure'] as const)('releases a %s grading borrower', async (mode) => {
    let finish!: () => void;
    state.hold = new Promise<void>((r) => (finish = r));
    const result = gradeLegs([{ key: 'synthetic|last', a: { lat: 40, lon: -30 }, b: { lat: 40.001, lon: -29.999 } }], {
        draftM: 2,
        draftAssumed: false,
        airDraftM: null,
        clusterSpanM: 24000,
        superseded: () => state.gradingDone,
        onLeg: () => {
            expect(noaaResidentBytes()).toBe(100_000);
            if (mode === 'callback failure') throw Error('Consumer stopped');
        },
    });
    await vi.waitFor(() => expect(state.builds).toBe(1));
    if (mode === 'superseded') state.gradingDone = true;
    finish();
    if (mode === 'callback failure') await expect(result).rejects.toThrow('Consumer');
    else await expect(result).resolves.toMatchObject({ superseded: mode === 'superseded' });
    expect(state.releases).toBe(1);
});
