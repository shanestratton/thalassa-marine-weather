import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
const mocks = vi.hoisted(() => ({ run: vi.fn(), fingerprint: 'one', listeners: new Set<() => void>() }));
vi.mock('../services/autoroutingReview', () => ({ reviewAutoroutingProposal: mocks.run }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => mocks.fingerprint,
    subscribe: (fn: () => void) => {
        mocks.listeners.add(fn);
        return () => mocks.listeners.delete(fn);
    },
}));
import { useAutoroutingReview } from '../components/autorouting/useAutoroutingReview';
const proposal: AutoroutingTrialRoute = {
    id: 'a',
    provider: 'Thalassa',
    warnings: [],
    createdAt: '2026-09-12',
    coordinates: [
        [153, -27],
        [153.01, -27],
    ],
};
const complete: TrialRouteReview = {
    phase: 'complete',
    legs: [
        {
            incomplete: false,
            verdict: {
                grade: 'clear',
                minDepthM: 8,
                issues: [],
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            },
        },
    ],
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.fingerprint = 'one';
    mocks.listeners.clear();
    mocks.run.mockResolvedValue(complete);
});
describe('disposable auto-review lifecycle', () => {
    it('binds completed review evidence to the exact proposal, geometry, profile, draft and chart registry', async () => {
        const vesselProfile = snapshotAutoroutingVesselProfile({ length: 40, beam: 12, airDraft: 60, draft: 8 });
        const route = {
            ...proposal,
            coordinates: [
                [153, -27],
                [153.0100000001, -27],
            ] as [number, number][],
            vesselProfile,
        };
        const startedAt = Date.now();
        const { result } = renderHook(() => useAutoroutingReview(route, 2.4384000001));
        await waitFor(() => expect(result.current.review).toMatchObject(complete));
        expect(result.current.review?.basis).toEqual({
            proposalId: 'a',
            geometryKey: autoroutingProposalGeometryKey(route.coordinates),
            vesselProfileKey: JSON.stringify(vesselProfile),
            draftM: 2.4384000001,
            draftAssumed: false,
            registryFingerprint: 'one',
            checkedAt: expect.any(String),
        });
        const checkedAt = Date.parse(result.current.review!.basis!.checkedAt);
        expect(checkedAt).toBeGreaterThanOrEqual(startedAt);
        expect(checkedAt).toBeLessThanOrEqual(Date.now());
        expect(mocks.run.mock.calls[0][4]).toEqual({ draftAssumed: false });
        expect(complete).not.toHaveProperty('basis');
    });

    it.each(['measured', 'estimated', 'missing', 'legacy'] as const)(
        'preserves %s draft provenance in both the checker options and review basis',
        async (status) => {
            const vesselProfile = snapshotAutoroutingVesselProfile({ draft: 8 });
            if (status !== 'legacy') vesselProfile.draftStatus = status;
            const route = { ...proposal, ...(status === 'legacy' ? {} : { vesselProfile }) };
            const { result } = renderHook(() => useAutoroutingReview(route, 2.4));
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            const expectedAssumed = status !== 'measured';
            expect(mocks.run.mock.calls[0][4]).toEqual({ draftAssumed: expectedAssumed });
            expect(result.current.review?.basis).toMatchObject({
                draftAssumed: expectedAssumed,
                vesselProfileKey: JSON.stringify(route.vesselProfile ?? null),
            });
        },
    );

    it('invalidates the first render and old callbacks when assumed status changes without a draft change', async () => {
        const renders: Array<TrialRouteReview | null> = [];
        const { result, rerender } = renderHook(
            ({ assumed }) => {
                const value = useAutoroutingReview(proposal, 2.4, assumed);
                renders.push(value.review);
                return value;
            },
            { initialProps: { assumed: false } },
        );
        await waitFor(() => expect(result.current.review).toMatchObject(complete));
        const oldSignal = mocks.run.mock.calls[0][2] as AbortSignal;
        const oldPublish = mocks.run.mock.calls[0][3] as (review: TrialRouteReview) => void;
        mocks.run.mockImplementationOnce(() => new Promise(() => {}));
        renders.length = 0;
        rerender({ assumed: true });
        expect(renders[0]).toBeNull();
        expect(oldSignal.aborted).toBe(true);
        act(() => oldPublish(complete));
        expect(result.current.review).toMatchObject({
            phase: 'checking',
            legs: [null],
            basis: { draftM: 2.4, draftAssumed: true },
        });
        expect(mocks.run.mock.calls[1][4]).toEqual({ draftAssumed: true });
    });

    it.each(['geometry', 'profile'] as const)(
        'fences same-object %s mutation before new effects and ignores callbacks from the old basis',
        async (changed) => {
            const route = {
                ...proposal,
                coordinates: proposal.coordinates.map(([lon, lat]) => [lon, lat] as [number, number]),
                vesselProfile: snapshotAutoroutingVesselProfile({ length: 40, beam: 12, draft: 8 }),
            };
            const renders: Array<TrialRouteReview | null> = [];
            const { result, rerender } = renderHook(() => {
                const value = useAutoroutingReview(route, 2.4);
                renders.push(value.review);
                return value;
            });
            await waitFor(() => expect(result.current.review).toMatchObject(complete));
            const oldBasis = { ...result.current.review!.basis! };
            const oldReview = result.current.review!;
            const oldSignal = mocks.run.mock.calls[0][2] as AbortSignal;
            const oldPublish = mocks.run.mock.calls[0][3] as (review: TrialRouteReview) => void;
            mocks.run.mockImplementationOnce(() => new Promise(() => {}));
            if (changed === 'geometry') route.coordinates[1][0] += 0.0000000001;
            else if (route.vesselProfile.beam.status !== 'missing') route.vesselProfile.beam.valueM += 0.0000000001;
            renders.length = 0;
            rerender();
            expect(renders[0]).toBeNull();
            expect(oldSignal.aborted).toBe(true);
            act(() => oldPublish(complete));
            expect(result.current.review).toMatchObject({
                phase: 'checking',
                legs: [null],
                basis: {
                    geometryKey: autoroutingProposalGeometryKey(route.coordinates),
                    vesselProfileKey: JSON.stringify(route.vesselProfile),
                    draftM: 2.4,
                    draftAssumed: false,
                    registryFingerprint: 'one',
                },
            });
            expect(oldReview.basis).toEqual(oldBasis);
            expect(
                result.current.review?.basis?.[changed === 'geometry' ? 'geometryKey' : 'vesselProfileKey'],
            ).not.toBe(oldBasis[changed === 'geometry' ? 'geometryKey' : 'vesselProfileKey']);
            expect(mocks.run).toHaveBeenCalledTimes(2);
        },
    );

    it('fences the first render when the same route has a changed draft, before effects reset the review', async () => {
        const renders: Array<TrialRouteReview | null> = [];
        const { result, rerender } = renderHook(
            ({ draft }) => {
                const review = useAutoroutingReview(proposal, draft);
                renders.push(review.review);
                return review;
            },
            { initialProps: { draft: 2.4 } },
        );
        await waitFor(() => expect(result.current.review).toMatchObject(complete));
        const oldSignal = mocks.run.mock.calls[0][2] as AbortSignal;
        mocks.run.mockImplementationOnce(() => new Promise(() => {}));
        renders.length = 0;
        rerender({ draft: 3.1 });
        expect(renders[0]).toBeNull();
        expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
        expect(oldSignal.aborted).toBe(true);
        expect(mocks.run.mock.calls[1][1]).toBe(3.1);
        expect(result.current.review?.basis).toMatchObject({ draftM: 3.1 });
    });

    it.each([undefined, 0, -1, NaN, Infinity, -Infinity])(
        'does not display old colours or start checks for invalid draft %s',
        async (draft) => {
            const renders: Array<TrialRouteReview | null> = [];
            const { result, rerender } = renderHook(
                ({ draft }) => {
                    const review = useAutoroutingReview(proposal, draft);
                    renders.push(review.review);
                    return review;
                },
                { initialProps: { draft: 2.4 as number | undefined } },
            );
            await waitFor(() => expect(result.current.review).toMatchObject(complete));
            const oldSignal = mocks.run.mock.calls[0][2] as AbortSignal;
            const oldPublish = mocks.run.mock.calls[0][3] as (v: TrialRouteReview) => void;
            renders.length = 0;
            rerender({ draft });
            expect(renders[0]).toBeNull();
            expect(result.current.review).toBeNull();
            expect(oldSignal.aborted).toBe(true);
            expect(mocks.run).toHaveBeenCalledTimes(1);
            act(() => oldPublish(complete));
            expect(result.current.review).toBeNull();
            expect(mocks.listeners.size).toBe(0);
        },
    );

    it('fences the first recheck render on the same route and draft, and aborts before rendering', async () => {
        const renders: Array<TrialRouteReview | null> = [];
        const { result } = renderHook(() => {
            const review = useAutoroutingReview(proposal, 2.4);
            renders.push(review.review);
            return review;
        });
        await waitFor(() => expect(result.current.review).toMatchObject(complete));
        const oldSignal = mocks.run.mock.calls[0][2] as AbortSignal;
        const oldPublish = mocks.run.mock.calls[0][3] as (v: TrialRouteReview) => void;
        mocks.run.mockImplementationOnce(() => new Promise(() => {}));
        renders.length = 0;
        act(() => {
            result.current.recheck();
            expect(oldSignal.aborted).toBe(true);
            oldPublish(complete);
        });
        expect(renders[0]).toBeNull();
        expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
        expect(mocks.run).toHaveBeenCalledTimes(2);
    });

    it('rejects old-draft progress, completion and detached registry callbacks after a new check starts', async () => {
        let resolveOld!: (value: TrialRouteReview) => void;
        let resolveNew!: (value: TrialRouteReview) => void;
        mocks.run.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        );
        mocks.run.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveNew = resolve;
                }),
        );
        const { result, rerender } = renderHook(({ draft }) => useAutoroutingReview(proposal, draft), {
            initialProps: { draft: 2.4 },
        });
        const publishOld = mocks.run.mock.calls[0][3] as (v: TrialRouteReview) => void;
        const detachedListener = [...mocks.listeners][0];
        rerender({ draft: 3.1 });
        await act(async () => {
            publishOld(complete);
            resolveOld(complete);
            mocks.fingerprint = 'changed-after-cleanup';
            detachedListener();
        });
        expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
        await act(async () => resolveNew(complete));
        expect(result.current.review).toMatchObject(complete);
        expect((mocks.run.mock.calls[1][2] as AbortSignal).aborted).toBe(false);
    });

    it.each(['completion', 'error'])(
        'rejects old-attempt %s when a recheck of the same route is pending',
        async (outcome) => {
            let rejectOld!: (error: Error) => void;
            let resolveOld!: (value: TrialRouteReview) => void;
            let resolveNew!: (value: TrialRouteReview) => void;
            mocks.run.mockImplementationOnce(
                () =>
                    new Promise((resolve, reject) => {
                        resolveOld = resolve;
                        rejectOld = reject;
                    }),
            );
            mocks.run.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveNew = resolve;
                    }),
            );
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            const publishOld = mocks.run.mock.calls[0][3] as (v: TrialRouteReview) => void;
            act(() => result.current.recheck());
            await act(async () => {
                publishOld(complete);
                if (outcome === 'completion') resolveOld(complete);
                else rejectOld(new Error('old request failed'));
            });
            expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
            await act(async () => resolveNew(complete));
            expect(result.current.review).toMatchObject(complete);
        },
    );

    it('clears colours on chart changes and rechecks only when requested', async () => {
        const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        expect(result.current.review?.basis?.registryFingerprint).toBe('one');
        act(() => {
            mocks.fingerprint = 'two';
            mocks.listeners.forEach((fn) => fn());
        });
        expect(result.current.review).toMatchObject({ phase: 'stale', legs: [null] });
        expect(result.current.review?.basis?.registryFingerprint).toBe('one');
        expect(mocks.run).toHaveBeenCalledTimes(1);
        act(() => result.current.recheck());
        await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        expect(result.current.review?.basis?.registryFingerprint).toBe('two');
    });
    it('ignores irrelevant registry notifications', async () => {
        const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        act(() => mocks.listeners.forEach((fn) => fn()));
        expect(result.current.review?.phase).toBe('complete');
        expect(mocks.run).toHaveBeenCalledTimes(1);
    });
    it('cancels Clear/Close and rejects late progress/completion for an old proposal', async () => {
        let resolve!: (v: TrialRouteReview) => void;
        mocks.run.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const { result, rerender, unmount } = renderHook(({ route }) => useAutoroutingReview(route, 2.4), {
            initialProps: { route: proposal as AutoroutingTrialRoute | null },
        });
        await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
        const signal = mocks.run.mock.calls[0][2] as AbortSignal;
        const publish = mocks.run.mock.calls[0][3] as (v: TrialRouteReview) => void;
        rerender({ route: null });
        expect(signal.aborted).toBe(true);
        await act(async () => {
            publish(complete);
            resolve(complete);
        });
        expect(result.current.review).toBe(null);
        rerender({ route: { ...proposal, id: 'b' } });
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        unmount();
        expect(mocks.listeners.size).toBe(0);
    });
    it('can stop a check and reports failures without leaving optimistic results', async () => {
        mocks.run.mockImplementationOnce(() => new Promise(() => {}));
        const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
        await waitFor(() => expect(result.current.review?.phase).toBe('checking'));
        act(() => result.current.stop());
        expect(result.current.review?.phase).toBe('stopped');
        expect((mocks.run.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
        mocks.run.mockRejectedValueOnce(new Error('offline'));
        act(() => result.current.recheck());
        await waitFor(() => expect(result.current.review).toMatchObject({ phase: 'error', legs: [null] }));
    });
});
