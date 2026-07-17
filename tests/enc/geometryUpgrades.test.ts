/**
 * Worker-protocol LIFECYCLE tests (closing audit: "the highest-risk new
 * code" had zero coverage — its only shipped bug lived exactly in this
 * seam). Drives dispatchGeometryWork → wire payload → reply handlers →
 * applyGlazeUpgrade with a fake Worker, over the REAL parking/cache
 * modules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';

// A controllable stand-in for the module-level Worker.
class FakeWorker {
    static instances: FakeWorker[] = [];
    static failNextPost = false;
    posted: unknown[] = [];
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
        FakeWorker.instances.push(this);
    }
    postMessage(msg: unknown): void {
        if (FakeWorker.failNextPost) {
            FakeWorker.failNextPost = false;
            throw new Error('clone failed');
        }
        this.posted.push(msg);
    }
}
vi.stubGlobal('Worker', FakeWorker);

import { dispatchGeometryWork, type GlazeUpgradeItem } from '../../services/enc/geometryUpgrades';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { putMergedData, clearMergedData, getMergedData } from '../../services/enc/mergedDataCache';
import {
    clearAllGlazeAssemblies,
    clearGlazeCell,
    getGlazeCell,
    glazeAssemblyCount,
    isGlazeInFlight,
    putGlazeCell,
    takeGlazeAssembly,
} from '../../services/enc/glazeCellCache';

const feat = (id: string): Feature => ({
    type: 'Feature',
    properties: { id },
    geometry: { type: 'Point', coordinates: [0, 0] },
});
const fc = (feats: Feature[] = []) => ({ type: 'FeatureCollection' as const, features: feats });

/** Minimal merged shell — only the fields the plumbing touches. */
const shell = (): EncMergedVectorData =>
    ({
        DEPARE_GLAZE: fc(),
        DEPCNT_DERIVED: fc(),
        SOUNDG: fc(),
        cellCount: 1,
    }) as unknown as EncMergedVectorData;

const item = (glazeKey: string, touched: string[], untouched: string[]): GlazeUpgradeItem => ({
    cellId: glazeKey.split('@')[0],
    glazeKey,
    features: touched.map(feat),
    coverageIds: ['fineA'],
    untouched: untouched.map(feat),
});

const lib = new Map([['fineA', { bbox: [0, 0, 1, 1] as [number, number, number, number], coverage: [] }]]);
const worker = (): FakeWorker => FakeWorker.instances[FakeWorker.instances.length - 1];
const lastMsg = (): { jobId: number; glazeCells: Array<Record<string, unknown>> } =>
    worker().posted[worker().posted.length - 1] as never;

describe('geometry-worker lifecycle', () => {
    beforeEach(() => {
        clearMergedData();
        clearGlazeCell();
        clearAllGlazeAssemblies();
        FakeWorker.failNextPost = false;
    });

    it('round trip: dispatch parks the untouched majority, strips it from the wire, reassembles on reply', () => {
        const merged = shell();
        putMergedData('mergeK', merged);
        putGlazeCell('cellX@1@9:s', { upgraded: false, feats: [feat('instant')] });
        dispatchGeometryWork(
            'mergeK',
            merged,
            false,
            [item('cellX@1@9:s', ['t1'], ['u1', 'u2'])],
            ['cellX@1@9:s'],
            lib,
        );

        const msg = lastMsg();
        expect(isGlazeInFlight('cellX@1@9:s')).toBe(true);
        expect(msg.glazeCells[0].untouched).toBeUndefined(); // stripped from the wire
        expect((msg.glazeCells[0].features as Feature[]).length).toBe(1);

        worker().onmessage!({
            data: {
                jobId: msg.jobId,
                type: 'glaze-cell',
                cellId: 'cellX',
                glazeKey: 'cellX@1@9:s',
                features: [feat('clipped')],
            },
        });
        const entry = getGlazeCell('cellX@1@9:s')!;
        expect(entry.upgraded).toBe(true);
        const ids = entry.feats.map((f) => (f.properties as { id: string }).id).sort();
        expect(ids).toEqual(['clipped', 'u1', 'u2']); // untouched + worker output
        expect(isGlazeInFlight('cellX@1@9:s')).toBe(false);

        worker().onmessage!({ data: { jobId: msg.jobId, type: 'done' } });
        expect(merged.DEPARE_GLAZE.features.map((f) => (f.properties as { id: string }).id).sort()).toEqual([
            'clipped',
            'u1',
            'u2',
        ]);
    });

    it('OVERLAPPING JOBS on the same glaze key keep separate parked majorities', () => {
        const m1 = shell();
        const m2 = shell();
        putMergedData('k1', m1);
        putMergedData('k2', m2);
        dispatchGeometryWork('k1', m1, false, [item('cellX@1@9:s', ['t'], ['job1-u'])], ['cellX@1@9:s'], lib);
        const job1 = lastMsg().jobId;
        dispatchGeometryWork('k2', m2, false, [item('cellX@1@9:s', ['t'], ['job2-u'])], ['cellX@1@9:s'], lib);
        const job2 = lastMsg().jobId;

        worker().onmessage!({
            data: { jobId: job1, type: 'glaze-cell', cellId: 'cellX', glazeKey: 'cellX@1@9:s', features: [feat('c1')] },
        });
        // Job 1 consumed ITS parked features; job 2's are intact.
        expect(takeGlazeAssembly(job2, 'cellX@1@9:s').map((f) => (f.properties as { id: string }).id)).toEqual([
            'job2-u',
        ]);
    });

    it('EVICTION-ABANDON: done with a missing glaze-cell entry leaves the fast merge untouched', () => {
        const merged = shell();
        merged.DEPARE_GLAZE.features = [feat('fast')];
        putMergedData('mergeK', merged);
        dispatchGeometryWork('mergeK', merged, false, [item('gone@1@9:s', ['t'], [])], ['gone@1@9:s'], lib);
        const jobId = lastMsg().jobId;
        // No glaze-cell reply ever stored an entry; 'done' must abandon.
        worker().onmessage!({ data: { jobId, type: 'done' } });
        expect(merged.DEPARE_GLAZE.features.map((f) => (f.properties as { id: string }).id)).toEqual(['fast']);
    });

    it('ERROR reply releases only that job’s parked state', () => {
        const m1 = shell();
        putMergedData('k1', m1);
        dispatchGeometryWork('k1', m1, false, [item('a@1@9:s', ['t'], ['ua'])], ['a@1@9:s'], lib);
        const job1 = lastMsg().jobId;
        dispatchGeometryWork('k1', m1, false, [item('b@1@9:s', ['t'], ['ub'])], ['b@1@9:s'], lib);
        worker().onmessage!({ data: { jobId: job1, type: 'error', message: 'boom' } });
        expect(isGlazeInFlight('a@1@9:s')).toBe(false);
        expect(isGlazeInFlight('b@1@9:s')).toBe(true); // other job untouched
    });

    it('postMessage failure releases the just-parked assemblies symmetrically', () => {
        const merged = shell();
        putMergedData('mergeK', merged);
        FakeWorker.failNextPost = true;
        dispatchGeometryWork('mergeK', merged, false, [item('x@1@9:s', ['t'], ['u'])], ['x@1@9:s'], lib);
        expect(glazeAssemblyCount()).toBe(0);
        expect(isGlazeInFlight('x@1@9:s')).toBe(false);
    });

    it('a glaze-cell STRAGGLER after the worker died does NOT cache an incomplete glaze (job-guard)', () => {
        const merged = shell();
        putMergedData('mergeK', merged);
        putGlazeCell('cellX@1@9:s', { upgraded: false, feats: [feat('instant')] });
        dispatchGeometryWork('mergeK', merged, false, [item('cellX@1@9:s', ['t1'], ['u1'])], ['cellX@1@9:s'], lib);
        const jobId = lastMsg().jobId;

        // Worker dies mid-flight: pendingGeometryJobs + all parked assemblies
        // are cleared. A queued 'glaze-cell' reply then straggles in.
        worker().onerror!();
        worker().onmessage!({
            data: { jobId, type: 'glaze-cell', cellId: 'cellX', glazeKey: 'cellX@1@9:s', features: [feat('clipped')] },
        });

        // The instant entry must SURVIVE — the straggler had no job and no
        // parked majority, so caching it would mark a touched-only, incomplete
        // glaze as upgraded:true (closing audit 2026-07-18). The job-guard drops it.
        const entry = getGlazeCell('cellX@1@9:s')!;
        expect(entry.upgraded).toBe(false);
        expect(entry.feats.map((f) => (f.properties as { id: string }).id)).toEqual(['instant']);
    });

    it('coverage library ships only the entries queued cells reference', () => {
        const merged = shell();
        putMergedData('mergeK', merged);
        const bigLib = new Map(lib);
        bigLib.set('fineUNUSED', { bbox: [5, 5, 6, 6], coverage: [] });
        dispatchGeometryWork('mergeK', merged, false, [item('y@1@9:s', ['t'], [])], ['y@1@9:s'], bigLib);
        const covLib = (lastMsg() as { coverageLib?: Record<string, unknown> }).coverageLib!;
        expect(Object.keys(covLib)).toEqual(['fineA']);
    });
});
