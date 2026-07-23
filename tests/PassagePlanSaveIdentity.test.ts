import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';

const mocks = vi.hoisted(() => ({
    fetchRoutes: vi.fn(),
    invalidate: vi.fn(),
    getCurrentUser: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    backfillEq: vi.fn(),
    backfill: vi.fn(),
    queue: vi.fn(),
    tombstone: vi.fn(),
    createVoyage: vi.fn(),
    deleteVoyage: vi.fn(),
    setActivePassage: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => {
            const backfillChain = {
                eq: (...args: unknown[]) => {
                    mocks.backfillEq(...args);
                    return backfillChain;
                },
                in: (...args: unknown[]) => mocks.backfill(...args),
            };
            return {
                upsert: (...args: unknown[]) => mocks.upsert(...args),
                update: (...args: unknown[]) => {
                    mocks.update(...args);
                    return backfillChain;
                },
            };
        },
    },
    getCurrentUser: (...args: unknown[]) => mocks.getCurrentUser(...args),
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    queueOfflineEntry: (...args: unknown[]) => mocks.queue(...args),
    addVoyageTombstone: (...args: unknown[]) => mocks.tombstone(...args),
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: (...args: unknown[]) => mocks.fetchRoutes(...args),
    invalidateRoutesAndTracks: (...args: unknown[]) => mocks.invalidate(...args),
}));
vi.mock('../services/VoyageService', () => ({
    createVoyage: (...args: unknown[]) => mocks.createVoyage(...args),
    deleteVoyageById: (...args: unknown[]) => mocks.deleteVoyage(...args),
}));
vi.mock('../services/PassagePlanService', () => ({
    setActivePassage: (...args: unknown[]) => mocks.setActivePassage(...args),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { savePassagePlanToLogbook } from '../services/shiplog/PassagePlanSave';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const plan: VoyagePlan = {
    origin: 'Brisbane, QLD',
    destination: 'Moreton Island, QLD',
    departureDate: '2026-07-23T00:00:00.000Z',
    originCoordinates: { lat: -27.47, lon: 153.03 },
    destinationCoordinates: { lat: -27.16, lon: 153.4 },
    distanceApprox: '25 NM',
    durationApprox: '5 hours',
    overview: 'A short coastal passage',
    waypoints: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    mocks.fetchRoutes.mockResolvedValue({ routes: [], tracks: [] });
    mocks.getCurrentUser.mockResolvedValue({ id: 'account-a' });
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.backfill.mockResolvedValue({ error: null, count: 2 });
    mocks.queue.mockResolvedValue('queued');
    mocks.tombstone.mockResolvedValue(undefined);
    mocks.createVoyage.mockResolvedValue({ voyage: { id: 'draft-a' } });
    mocks.deleteVoyage.mockResolvedValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('PassagePlanSave persistence and identity ownership', () => {
    it('abandons A after a deferred duplicate lookup without saving in B', async () => {
        const lookup = deferred<{ routes: []; tracks: [] }>();
        mocks.fetchRoutes.mockReturnValueOnce(lookup.promise);
        const eventSpy = vi.spyOn(window, 'dispatchEvent');
        const request = savePassagePlanToLogbook(plan);
        await vi.waitFor(() => expect(mocks.fetchRoutes).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        lookup.resolve({ routes: [], tracks: [] });

        await expect(request).resolves.toBeNull();
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
        expect(eventSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'thalassa:passage-plan-saved' }));
    });

    it('uses owner-scoped stable operation IDs and exact linked-plan backfill', async () => {
        const voyageId = await savePassagePlanToLogbook(plan);

        expect(voyageId).toMatch(/^planned_/);
        expect(mocks.upsert).toHaveBeenCalledOnce();
        const [rows, options] = mocks.upsert.mock.calls[0] as [Array<Record<string, unknown>>, { onConflict: string }];
        expect(options).toEqual({ onConflict: 'user_id,client_operation_id' });
        expect(new Set(rows.map((row) => row.client_operation_id)).size).toBe(2);
        expect(
            rows.every(
                (row) =>
                    row.user_id === 'account-a' &&
                    row.voyage_id === voyageId &&
                    row.linked_plan_id === 'draft-a' &&
                    typeof row.client_operation_id === 'string' &&
                    /^passage_[A-Za-z0-9_-]+$/.test(row.client_operation_id),
            ),
        ).toBe(true);
        expect(mocks.update).toHaveBeenCalledWith({ linked_plan_id: 'draft-a' }, { count: 'exact' });
        expect(mocks.backfillEq).toHaveBeenNthCalledWith(1, 'user_id', 'account-a');
        expect(mocks.backfillEq).toHaveBeenNthCalledWith(2, 'voyage_id', voyageId);
        expect(mocks.backfill).toHaveBeenCalledWith(
            'client_operation_id',
            rows.map((row) => row.client_operation_id),
        );
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.setActivePassage).toHaveBeenCalledWith('draft-a');
    });

    it('reuses the exact online operation IDs and draft link in fallback', async () => {
        mocks.upsert.mockResolvedValueOnce({ error: { message: 'timeout' } });

        await expect(savePassagePlanToLogbook(plan)).resolves.toMatch(/^planned_/);

        const rows = mocks.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
        expect(mocks.queue).toHaveBeenCalledTimes(2);
        for (let index = 0; index < rows.length; index++) {
            const [entry, options] = mocks.queue.mock.calls[index] as [
                Record<string, unknown>,
                { operationId: string; expectedScope: { userId: string } },
            ];
            expect(entry.linkedPlanId).toBe('draft-a');
            expect(options.operationId).toBe(rows[index].client_operation_id);
            expect(options.expectedScope.userId).toBe('account-a');
        }
        expect(mocks.setActivePassage).toHaveBeenCalledWith('draft-a');
    });

    it('compensates a partial offline batch and removes its exact draft', async () => {
        mocks.upsert.mockResolvedValueOnce({ error: { message: 'offline' } });
        mocks.queue.mockResolvedValueOnce('first').mockRejectedValueOnce(new Error('storage full'));
        const eventSpy = vi.spyOn(window, 'dispatchEvent');

        await expect(savePassagePlanToLogbook(plan)).resolves.toBeNull();

        const failedVoyageId = (mocks.queue.mock.calls[0][0] as { voyageId: string }).voyageId;
        expect(mocks.tombstone).toHaveBeenCalledOnce();
        expect(mocks.tombstone.mock.calls[0][0]).toBe(failedVoyageId);
        expect((mocks.tombstone.mock.calls[0][1] as { userId: string }).userId).toBe('account-a');
        expect(mocks.deleteVoyage).toHaveBeenCalledWith('draft-a');
        expect(mocks.invalidate).not.toHaveBeenCalled();
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
        expect(eventSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'thalassa:passage-plan-saved' }));
    });

    it('never falls back to B when A upsert resolves after an account switch', async () => {
        const upsert = deferred<{ error: { message: string } }>();
        mocks.upsert.mockReturnValueOnce(upsert.promise);
        const request = savePassagePlanToLogbook(plan);
        await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        upsert.resolve({ error: { message: 'offline' } });

        await expect(request).resolves.toBeNull();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.tombstone).not.toHaveBeenCalled();
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
    });

    it('rejects a remote session whose owner does not match the captured scope', async () => {
        mocks.getCurrentUser.mockResolvedValueOnce({ id: 'account-b' });

        await expect(savePassagePlanToLogbook(plan)).resolves.toBeNull();

        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
    });

    it('does not write or activate after the account changes during draft creation', async () => {
        const draft = deferred<{ voyage: { id: string } }>();
        mocks.createVoyage.mockReturnValueOnce(draft.promise);
        const eventSpy = vi.spyOn(window, 'dispatchEvent');
        const request = savePassagePlanToLogbook(plan);
        await vi.waitFor(() => expect(mocks.createVoyage).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        draft.resolve({ voyage: { id: 'draft-a' } });

        await expect(request).resolves.toBeNull();
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
        expect(eventSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'thalassa:passage-plan-saved' }));
    });

    it('preserves anonymous planning in its isolated offline queue', async () => {
        setAuthIdentityScope(null);
        const eventSpy = vi.spyOn(window, 'dispatchEvent');
        const voyageId = await savePassagePlanToLogbook(plan);

        expect(voyageId).toMatch(/^planned_/);
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).toHaveBeenCalledTimes(2);
        const operationIds = mocks.queue.mock.calls.map((call) => (call[1] as { operationId: string }).operationId);
        expect(new Set(operationIds).size).toBe(2);
        expect(
            mocks.queue.mock.calls.every(
                (call) => (call[1] as { expectedScope: { userId: null } }).expectedScope.userId === null,
            ),
        ).toBe(true);
        expect(mocks.createVoyage).not.toHaveBeenCalled();
        expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'thalassa:passage-plan-saved' }));
    });
});
