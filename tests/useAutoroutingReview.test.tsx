import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
const mocks = vi.hoisted(() => ({
    run: vi.fn(),
    /** The charts round the route (a scoped fingerprint). */
    fingerprint: 'one',
    /** The whole library, where it differs (charts far from the route). */
    whole: null as string | null,
    scopes: [] as unknown[],
    listeners: new Set<() => void>(),
    /** A download walk's cells still to land (0: none running). */
    walkRemaining: 0,
    walkListeners: new Set<(p: { remaining: number; total: number }) => void>(),
}));
vi.mock('../services/autoroutingReview', () => ({ reviewAutoroutingProposal: mocks.run }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: (scope?: unknown) => {
        mocks.scopes.push(scope);
        return scope ? mocks.fingerprint : (mocks.whole ?? mocks.fingerprint);
    },
    subscribe: (fn: () => void) => {
        mocks.listeners.add(fn);
        return () => mocks.listeners.delete(fn);
    },
}));
vi.mock('../services/enc/encHydrationProgress', () => ({
    getHydrationProgress: () => ({ remaining: mocks.walkRemaining, total: 40 }),
    subscribeHydration: (fn: (p: { remaining: number; total: number }) => void) => {
        mocks.walkListeners.add(fn);
        return () => mocks.walkListeners.delete(fn);
    },
}));
import {
    AUTO_RECHECK_MAX,
    AUTO_RECHECK_QUIET_MS,
    AUTO_RECHECK_WALKS_MAX,
    useAutoroutingReview,
} from '../components/autorouting/useAutoroutingReview';
import { traceRegistryScope } from '../services/traceRegistryScope';
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
    mocks.whole = null;
    mocks.scopes = [];
    mocks.listeners.clear();
    mocks.walkRemaining = 0;
    mocks.walkListeners.clear();
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

    // Package 125-06 (Shane's Auto route, Port of Airlie → Nara Inlet,
    // 2026-10-08: a freshly made route said "Chart checks stale"). The review
    // was bound to the WHOLE chart library, and any chart landing anywhere —
    // the map loading detail round the new route, a Pi or cloud sync, a cell
    // the check itself fetched — parked it at 'stale' until Recheck. It is now
    // bound to the charts round the route (the route check's and Cast Off's
    // own scope, traceRegistryScope), and when those change it checks again by
    // itself, once they settle.
    it('binds the review to the charts round this route only (the route check and Cast Off scope)', async () => {
        const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        const scope = traceRegistryScope(proposal.coordinates.map(([lon, lat]) => ({ lat, lon })));
        expect(scope).toBeDefined();
        expect(mocks.scopes.length).toBeGreaterThan(0);
        for (const s of mocks.scopes) expect(s).toEqual(scope);
    });

    it('charts changing away from the route leave its check alone', async () => {
        const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
        await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        act(() => {
            mocks.whole = 'a cell synced on the far side of the world';
            mocks.listeners.forEach((fn) => fn());
        });
        expect(result.current.review?.phase).toBe('complete');
        expect(mocks.run).toHaveBeenCalledTimes(1);
    });

    describe('a chart under the route changes', () => {
        beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
        afterEach(() => vi.useRealTimers());
        const change = (fingerprint: string) =>
            act(() => {
                mocks.fingerprint = fingerprint;
                mocks.listeners.forEach((fn) => fn());
            });
        const settle = () =>
            act(async () => {
                vi.advanceTimersByTime(AUTO_RECHECK_QUIET_MS);
            });

        it('after the check: the old colours go, and it checks again by itself — complete, never stale', async () => {
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            expect(result.current.review?.basis?.registryFingerprint).toBe('one');
            change('two');
            expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
            expect(mocks.run).toHaveBeenCalledTimes(1);
            await settle();
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            expect(mocks.run).toHaveBeenCalledTimes(2);
            expect(result.current.review?.basis?.registryFingerprint).toBe('two');
        });

        it('while it checks: that check is dropped, and one more runs once the charts settle', async () => {
            mocks.run.mockImplementationOnce(() => new Promise(() => {}));
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
            const first = mocks.run.mock.calls[0][2] as AbortSignal;
            // The map loading detail round the route lands cells in waves.
            change('two');
            expect(first.aborted).toBe(true);
            await act(async () => {
                vi.advanceTimersByTime(AUTO_RECHECK_QUIET_MS / 2);
            });
            change('three');
            await act(async () => {
                vi.advanceTimersByTime(AUTO_RECHECK_QUIET_MS / 2);
            });
            expect(mocks.run).toHaveBeenCalledTimes(1);
            expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
            await settle();
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            expect(mocks.run).toHaveBeenCalledTimes(2);
            expect(result.current.review?.basis?.registryFingerprint).toBe('three');
        });

        it('stops checking by itself after AUTO_RECHECK_MAX changes: stale until Recheck', async () => {
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            for (let k = 0; k < AUTO_RECHECK_MAX; k++) {
                change(`churn-${k}`);
                await settle();
                await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            }
            expect(mocks.run).toHaveBeenCalledTimes(1 + AUTO_RECHECK_MAX);
            change('churn-again');
            expect(result.current.review).toMatchObject({ phase: 'stale', legs: [null] });
            await settle();
            expect(mocks.run).toHaveBeenCalledTimes(1 + AUTO_RECHECK_MAX);
            act(() => result.current.recheck());
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            expect(result.current.review?.basis?.registryFingerprint).toBe('churn-again');
        });

        // Review, 2026-10-09: a download walk round a fresh route (the map's
        // "ENC: loading chart…") lands its cells in waves — at its first cell,
        // then every 8 cells or 10 s — and each wave more than the quiet
        // period after the last spent one of AUTO_RECHECK_MAX checks: a walk
        // of four waves parked the fresh route at 'stale' after all.
        const walk = (remaining: number) =>
            act(() => {
                mocks.walkRemaining = remaining;
                mocks.walkListeners.forEach((fn) => fn({ remaining, total: 40 }));
            });

        it.each([4, 6, 12])(
            'a download walk of %i waves round a fresh route: one check when it ends, complete — never stale',
            async (waves) => {
                const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
                await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
                walk(40);
                for (let k = 0; k < waves; k++) {
                    change(`wave-${k}`);
                    walk(40 - (k + 1) * 3);
                    await act(async () => {
                        vi.advanceTimersByTime(AUTO_RECHECK_QUIET_MS + 1_000);
                    });
                    expect(result.current.review).toMatchObject({ phase: 'checking', legs: [null] });
                }
                expect(mocks.run).toHaveBeenCalledTimes(1);
                // The walk ends; its tail lands just after.
                walk(0);
                change('tail');
                await settle();
                await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
                expect(mocks.run).toHaveBeenCalledTimes(2);
                expect(result.current.review?.basis?.registryFingerprint).toBe('tail');
                // A walk spends none of the checks other changes may run.
                for (let k = 0; k < AUTO_RECHECK_MAX; k++) {
                    change(`sync-${k}`);
                    await settle();
                    await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
                }
                expect(mocks.run).toHaveBeenCalledTimes(2 + AUTO_RECHECK_MAX);
            },
        );

        it('a fresh route shown while a walk is landing charts under it: checked once the walk ends', async () => {
            mocks.walkRemaining = 25;
            mocks.run.mockImplementationOnce(() => new Promise(() => {}));
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
            for (let k = 0; k < 5; k++) {
                change(`wave-${k}`);
                await act(async () => {
                    vi.advanceTimersByTime(2_500);
                });
            }
            expect(mocks.run).toHaveBeenCalledTimes(1);
            walk(0);
            await settle();
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            expect(mocks.run).toHaveBeenCalledTimes(2);
        });

        it(`walks that never end are said too: stale after ${AUTO_RECHECK_WALKS_MAX} walks, until Recheck`, async () => {
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            for (let k = 0; k < AUTO_RECHECK_WALKS_MAX; k++) {
                walk(10);
                change(`walk-${k}`);
                walk(0);
                await settle();
                await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
            }
            expect(mocks.run).toHaveBeenCalledTimes(1 + AUTO_RECHECK_WALKS_MAX);
            walk(10);
            change('walk-again');
            expect(result.current.review).toMatchObject({ phase: 'stale', legs: [null] });
            act(() => result.current.recheck());
            await waitFor(() => expect(result.current.review?.phase).toBe('complete'));
        });

        it('a stopped check stays stopped', async () => {
            mocks.run.mockImplementationOnce(() => new Promise(() => {}));
            const { result } = renderHook(() => useAutoroutingReview(proposal, 2.4));
            await waitFor(() => expect(result.current.review?.phase).toBe('checking'));
            act(() => result.current.stop());
            change('two');
            await settle();
            expect(result.current.review?.phase).toBe('stopped');
            expect(mocks.run).toHaveBeenCalledTimes(1);
        });
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
