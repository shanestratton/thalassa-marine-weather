import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const harness = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    startLeg: vi.fn(),
    closeLeg: vi.fn(),
    getActiveLeg: vi.fn(),
    deleteLegsForVoyage: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: harness.getUser,
        },
        from: harness.from,
        rpc: harness.rpc,
    },
}));

vi.mock('../services/VoyageLegService', () => ({
    startLeg: harness.startLeg,
    closeLeg: harness.closeLeg,
    getActiveLeg: harness.getActiveLeg,
    deleteLegsForVoyage: harness.deleteLegsForVoyage,
}));

import {
    createVoyage,
    deleteDraftVoyagesByNameAndDay,
    deleteVoyageById,
    endVoyage,
    getActiveVoyage,
    getAllVoyagesForUser,
    getDraftVoyages,
    getVoyageById,
    isWeatherMaster,
    setWeatherMaster,
    updateVoyage,
    type Voyage,
} from '../services/VoyageService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function queryFor<T>(result: T | Promise<T>) {
    const promise = Promise.resolve(result);
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
        query[method] = vi.fn().mockReturnValue(query);
    }
    query.single = vi.fn().mockReturnValue(promise);
    query.maybeSingle = vi.fn().mockReturnValue(promise);
    query.then = vi.fn((resolve, reject) => promise.then(resolve, reject));
    return query;
}

function authUser(id: string) {
    return {
        data: { user: { id } },
        error: null,
    };
}

function voyage(ownerId = 'account-a', id = 'voyage-1', status: Voyage['status'] = 'planning'): Voyage {
    return {
        id,
        user_id: ownerId,
        vessel_id: null,
        voyage_name: 'Brisbane to Noumea',
        departure_port: 'Brisbane',
        destination_port: 'Noumea',
        departure_time: null,
        eta: null,
        crew_count: 4,
        status,
        weather_master_id: ownerId,
        notes: null,
        created_at: '2026-07-23T01:00:00.000Z',
        updated_at: '2026-07-23T01:00:00.000Z',
    };
}

function passageMembership(ownerId: string, crewUserId: string, voyageId: string | null = null) {
    return {
        owner_id: ownerId,
        crew_user_id: crewUserId,
        status: 'accepted',
        voyage_id: voyageId,
        permissions: { can_view_passage: true },
    };
}

describe('VoyageService exact identity and account isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        harness.getUser.mockResolvedValue(authUser('account-a'));
        harness.getActiveLeg.mockReturnValue(null);
    });

    it('owner-binds draft updates, strips hostile identity fields, and drops stale completions', async () => {
        const updateResult = deferred<{ data: Voyage; error: null }>();
        const updateQuery = queryFor(updateResult.promise);
        harness.from.mockReturnValue(updateQuery);
        const dispatch = vi.spyOn(window, 'dispatchEvent');

        const pending = updateVoyage('voyage-1', {
            voyage_name: 'Safe name',
            id: 'voyage-b',
            user_id: 'account-b',
            status: 'active',
        } as never);
        await vi.waitFor(() => expect(updateQuery.update).toHaveBeenCalledOnce());

        const payload = updateQuery.update.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toMatchObject({ voyage_name: 'Safe name' });
        expect(payload).not.toHaveProperty('id');
        expect(payload).not.toHaveProperty('user_id');
        expect(payload).not.toHaveProperty('status');
        expect(updateQuery.eq).toHaveBeenCalledWith('id', 'voyage-1');
        expect(updateQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(updateQuery.eq).toHaveBeenCalledWith('status', 'planning');

        setAuthIdentityScope('account-b');
        updateResult.resolve({ data: voyage('account-a'), error: null });

        await expect(pending).resolves.toMatchObject({ voyage: null });
        expect(localStorage.getItem(authScopedStorageKey('thalassa_draft_voyages'))).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('never closes legs, clears cache, or emits an event for a stale end-voyage response', async () => {
        const activeA = voyage('account-a', 'voyage-1', 'active');
        localStorage.setItem(authScopedStorageKey('thalassa_active_voyage'), JSON.stringify(activeA));
        setAuthIdentityScope('account-b');
        const activeB = voyage('account-b', 'voyage-b', 'active');
        const accountBKey = authScopedStorageKey('thalassa_active_voyage');
        localStorage.setItem(accountBKey, JSON.stringify(activeB));
        setAuthIdentityScope('account-a');

        const updateResult = deferred<{ data: Voyage; error: null }>();
        const updateQuery = queryFor(updateResult.promise);
        harness.from.mockReturnValue(updateQuery);
        harness.getActiveLeg.mockReturnValue({ id: 'leg-a', voyage_id: 'voyage-1', status: 'active' });
        const dispatch = vi.spyOn(window, 'dispatchEvent');

        const pending = endVoyage('voyage-1');
        await vi.waitFor(() => expect(updateQuery.update).toHaveBeenCalledWith({ status: 'completed' }));
        expect(updateQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(updateQuery.eq).toHaveBeenCalledWith('status', 'active');
        expect(harness.closeLeg).not.toHaveBeenCalled();

        setAuthIdentityScope('account-b');
        updateResult.resolve({ data: voyage('account-a', 'voyage-1', 'completed'), error: null });

        await expect(pending).resolves.toBe(false);
        expect(harness.closeLeg).not.toHaveBeenCalled();
        expect(harness.deleteLegsForVoyage).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(accountBKey) || 'null')).toEqual(activeB);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not perform eager local deletion when the owner-filtered remote delete fails', async () => {
        const active = voyage('account-a', 'voyage-1', 'active');
        const cacheKey = authScopedStorageKey('thalassa_active_voyage');
        localStorage.setItem(cacheKey, JSON.stringify(active));
        const deleteResult = deferred<{ data: null; error: { message: string } }>();
        const deleteQuery = queryFor(deleteResult.promise);
        harness.from.mockReturnValue(deleteQuery);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const dispatch = vi.spyOn(window, 'dispatchEvent');

        const pending = deleteVoyageById('voyage-1');
        await vi.waitFor(() => expect(deleteQuery.delete).toHaveBeenCalledOnce());
        expect(deleteQuery.eq).toHaveBeenCalledWith('id', 'voyage-1');
        expect(deleteQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(harness.deleteLegsForVoyage).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(cacheKey) || 'null')).toEqual(active);

        deleteResult.resolve({ data: null, error: { message: 'denied' } });

        await expect(pending).resolves.toBe(false);
        expect(harness.deleteLegsForVoyage).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(cacheKey) || 'null')).toEqual(active);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('filters hostile owner/status rows from owner-only voyage lists', async () => {
        const draftQuery = queryFor({
            data: [
                voyage('account-a', 'owned-draft', 'planning'),
                voyage('account-b', 'foreign-draft', 'planning'),
                voyage('account-a', 'active-row', 'active'),
            ],
            error: null,
        });
        const allQuery = queryFor({
            data: [voyage('account-a', 'owned-complete', 'completed'), voyage('account-b', 'foreign', 'completed')],
            error: null,
        });
        harness.from.mockReturnValueOnce(draftQuery).mockReturnValueOnce(allQuery);

        await expect(getDraftVoyages()).resolves.toEqual([voyage('account-a', 'owned-draft', 'planning')]);
        await expect(getAllVoyagesForUser()).resolves.toEqual([voyage('account-a', 'owned-complete', 'completed')]);
        expect(draftQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(draftQuery.eq).toHaveBeenCalledWith('status', 'planning');
        expect(allQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
    });

    it('preserves crew-visible active voyages only with an exact authorized membership', async () => {
        setAuthIdentityScope('crew-user');
        harness.getUser.mockResolvedValue(authUser('crew-user'));
        const sharedVoyage = voyage('captain-1', 'shared-voyage', 'active');
        const ownerQuery = queryFor({ data: null, error: null });
        const crewVoyageQuery = queryFor({ data: sharedVoyage, error: null });
        const membershipQuery = queryFor({
            data: [passageMembership('captain-1', 'crew-user', 'shared-voyage')],
            error: null,
        });
        harness.from
            .mockReturnValueOnce(ownerQuery)
            .mockReturnValueOnce(crewVoyageQuery)
            .mockReturnValueOnce(membershipQuery);

        await expect(getActiveVoyage()).resolves.toEqual(sharedVoyage);
        expect(ownerQuery.eq).toHaveBeenCalledWith('user_id', 'crew-user');
        expect(membershipQuery.eq).toHaveBeenCalledWith('owner_id', 'captain-1');
        expect(membershipQuery.eq).toHaveBeenCalledWith('crew_user_id', 'crew-user');
        expect(membershipQuery.eq).toHaveBeenCalledWith('status', 'accepted');
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage')) || 'null')).toEqual(
            sharedVoyage,
        );
    });

    it('rejects a crew voyage when the returned membership belongs to another owner or voyage', async () => {
        setAuthIdentityScope('crew-user');
        harness.getUser.mockResolvedValue(authUser('crew-user'));
        const ownerQuery = queryFor({ data: null, error: null });
        const crewVoyageQuery = queryFor({
            data: voyage('captain-1', 'shared-voyage', 'active'),
            error: null,
        });
        const membershipQuery = queryFor({
            data: [passageMembership('captain-2', 'crew-user', 'different-voyage')],
            error: null,
        });
        harness.from
            .mockReturnValueOnce(ownerQuery)
            .mockReturnValueOnce(crewVoyageQuery)
            .mockReturnValueOnce(membershipQuery);

        await expect(getActiveVoyage()).resolves.toBeNull();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_active_voyage'))).toBeNull();
    });

    it('validates the exact requested ID and crew authorization for a single-voyage read', async () => {
        setAuthIdentityScope('crew-user');
        harness.getUser.mockResolvedValue(authUser('crew-user'));
        const voyageQuery = queryFor({
            data: voyage('captain-1', 'different-voyage', 'active'),
            error: null,
        });
        harness.from.mockReturnValue(voyageQuery);

        await expect(getVoyageById('requested-voyage')).resolves.toBeNull();
        expect(voyageQuery.eq).toHaveBeenCalledWith('id', 'requested-voyage');
        expect(harness.from).toHaveBeenCalledTimes(1);
    });

    it('fails the weather-master check closed when active-voyage authorization cannot be verified', async () => {
        const ownerQuery = queryFor({
            data: null,
            error: { message: 'network unavailable' },
        });
        harness.from.mockReturnValue(ownerQuery);

        await expect(isWeatherMaster()).resolves.toBe(false);
        expect(ownerQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(harness.from).toHaveBeenCalledTimes(1);
    });

    it('deletes only validated owner drafts and binds the destructive query to owner and status', async () => {
        const candidateQuery = queryFor({
            data: [voyage('account-a', 'owned-draft', 'planning'), voyage('account-b', 'foreign-draft', 'planning')],
            error: null,
        });
        const deleteQuery = queryFor({
            data: [{ id: 'owned-draft', user_id: 'account-a', status: 'planning' }],
            error: null,
        });
        harness.from.mockReturnValueOnce(candidateQuery).mockReturnValueOnce(deleteQuery);

        await expect(deleteDraftVoyagesByNameAndDay('Brisbane to Noumea', '2026-07-23')).resolves.toBe(1);
        expect(candidateQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(candidateQuery.eq).toHaveBeenCalledWith('status', 'planning');
        expect(deleteQuery.in).toHaveBeenCalledWith('id', ['owned-draft']);
        expect(deleteQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(deleteQuery.eq).toHaveBeenCalledWith('status', 'planning');
    });

    it('requires an accepted passage-authorized target before assigning weather master', async () => {
        const ownedVoyage = voyage('account-a', 'voyage-1', 'active');
        const voyageQuery = queryFor({ data: ownedVoyage, error: null });
        const membershipQuery = queryFor({
            data: [passageMembership('account-a', 'crew-user', 'voyage-1')],
            error: null,
        });
        const updateQuery = queryFor({
            data: { ...ownedVoyage, weather_master_id: 'crew-user' },
            error: null,
        });
        harness.from
            .mockReturnValueOnce(voyageQuery)
            .mockReturnValueOnce(membershipQuery)
            .mockReturnValueOnce(updateQuery);

        await expect(setWeatherMaster('voyage-1', 'crew-user')).resolves.toBe(true);
        expect(voyageQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(membershipQuery.eq).toHaveBeenCalledWith('owner_id', 'account-a');
        expect(membershipQuery.eq).toHaveBeenCalledWith('crew_user_id', 'crew-user');
        expect(updateQuery.eq).toHaveBeenCalledWith('id', 'voyage-1');
        expect(updateQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
    });

    it('rejects create responses whose embedded owner does not match the authenticated account', async () => {
        const createQuery = queryFor({
            data: voyage('account-b', 'voyage-b', 'planning'),
            error: null,
        });
        harness.from.mockReturnValue(createQuery);

        await expect(
            createVoyage({
                voyage_name: 'Brisbane to Noumea',
                departure_port: 'Brisbane',
                destination_port: 'Noumea',
                crew_count: 4,
            }),
        ).resolves.toMatchObject({ voyage: null });
        expect(createQuery.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: 'account-a',
                weather_master_id: 'account-a',
                status: 'planning',
            }),
        );
    });

    it('drops an owner-list result that resolves after the identity generation changes', async () => {
        const listResult = deferred<{ data: Voyage[]; error: null }>();
        const listQuery = queryFor(listResult.promise);
        harness.from.mockReturnValue(listQuery);
        const accountAScope = getAuthIdentityScope();

        const pending = getDraftVoyages();
        await vi.waitFor(() => expect(listQuery.order).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        listResult.resolve({ data: [voyage('account-a')], error: null });

        await expect(pending).resolves.toEqual([]);
        expect(localStorage.getItem(authScopedStorageKey('thalassa_draft_voyages', accountAScope))).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_draft_voyages'))).toBeNull();
    });
});
