/**
 * The galley share waits for the server (2026-10-03). A ticked Galley shares
 * the skipper's galley only once the server has the galley policies
 * (migration 20261003100000, whose galley_share_ready() the app asks). Before
 * that the app behaves exactly as it did: no galley share, no error, nothing
 * forced. No real accounts: 'skipper-1', 'crew-<n>', 'Test Boat'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const db = vi.hoisted(() => ({
    crewRows: [] as Record<string, unknown>[],
    sessionIdentity: 'crew-1' as string | null,
    from: vi.fn(),
    rpc: vi.fn(),
}));

function query(result: () => { data: unknown; error: unknown }) {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in']) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
    return builder;
}

vi.mock('../services/supabase', () => ({
    supabase: { from: db.from, rpc: db.rpc },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getLocalDatabaseSession: () => ({ identity: db.sessionIdentity, generation: 1 }),
    isLocalDatabaseSessionCurrent: () => true,
}));

import {
    binderRegisterForRow,
    deriveBinderAccess,
    galleyShareOwner,
    getBinderSource,
    isGalleyShareLive,
    refreshSharedBinders,
    reloadSharedBindersFromStorage,
} from '../services/vessel/sharedBinders';

const NOT_PUSHED = {
    data: null,
    error: {
        code: 'PGRST202',
        message: 'Could not find the function public.galley_share_ready without parameters in the schema cache',
    },
};
const PUSHED = { data: true, error: null };

let accountCounter = 0;
let crew = 'crew-1';

function membership(overrides: Record<string, unknown> = {}) {
    return {
        owner_id: 'skipper-1',
        crew_user_id: crew,
        status: 'accepted',
        shared_registers: ['galley', 'passage_chat'],
        permissions: { can_view_stores: false, can_edit_stores: false, can_view_galley: true },
        created_at: '2026-10-02T21:00:00.000Z',
        ...overrides,
    };
}

beforeEach(() => {
    localStorage.clear();
    accountCounter += 1;
    crew = `crew-${accountCounter}`;
    db.crewRows = [membership()];
    db.sessionIdentity = crew;
    db.from.mockReset();
    db.from.mockImplementation((table: string) =>
        table === 'vessel_crew'
            ? query(() => ({ data: db.crewRows, error: null }))
            : query(() => ({ data: [{ owner_id: 'skipper-1', vessel_name: 'Test Boat' }], error: null })),
    );
    db.rpc.mockReset();
    db.rpc.mockResolvedValue(NOT_PUSHED);
    setAuthIdentityScope(crew);
    reloadSharedBindersFromStorage();
});

afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('deriveBinderAccess and the galley', () => {
    it('grants the galley (read = write = ticked) only once the server can share it', () => {
        expect(deriveBinderAccess([membership()], crew)).toEqual([]);
        const [skipper] = deriveBinderAccess([membership()], crew, { galleyLive: true });
        expect(skipper.registers.galley).toEqual({ read: true, write: true });
        expect(skipper.registers.stores).toEqual({ read: false, write: false });
        const [unticked] = deriveBinderAccess([membership({ shared_registers: ['equipment'] })], crew, {
            galleyLive: true,
        });
        expect(unticked.registers.galley).toEqual({ read: false, write: false });
    });

    it('a meal plan or grocery item for a passage is the passage share’s, not the galley’s', () => {
        expect(binderRegisterForRow('recipes', { voyage_id: 'voyage-1' })).toBe('galley');
        expect(binderRegisterForRow('meal_plans', { voyage_id: null })).toBe('galley');
        expect(binderRegisterForRow('shopping_list', {})).toBe('galley');
        expect(binderRegisterForRow('meal_plans', { voyage_id: 'voyage-1' })).toBeNull();
        expect(binderRegisterForRow('shopping_list', { voyage_id: 'voyage-1' })).toBeNull();
        expect(binderRegisterForRow('passage_provisions', { voyage_id: null })).toBeNull();
        expect(binderRegisterForRow('inventory_items', { voyage_id: 'voyage-1' })).toBe('stores');
    });
});

describe('before the galley migration is pushed', () => {
    it('a ticked Galley shares nothing, quietly: no error, no forced full pull, the own galley stays', async () => {
        const result = await refreshSharedBinders();

        expect(db.rpc).toHaveBeenCalledWith('galley_share_ready');
        expect(result).toEqual({ changed: false, fresh: true });
        expect(isGalleyShareLive()).toBe(false);
        expect(getBinderSource('galley')).toEqual({ mode: 'own' });
        expect(galleyShareOwner()).toBeNull();
    });

    it('while a skipper has ticked Galley it asks every five minutes, not every cycle', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
        // Every prompt push after an edit runs a cycle: one question per launch
        // and per five minutes is enough to notice the push.
        await refreshSharedBinders();
        await refreshSharedBinders();
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-10-03T00:04:59.000Z'));
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-10-03T00:05:00.000Z'));
        db.rpc.mockResolvedValue(PUSHED);
        const result = await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(2);

        // A change of share: the cycle forces the full pull that brings the
        // skipper's galley rows in.
        expect(result).toEqual({ changed: true, fresh: true });
        expect(isGalleyShareLive()).toBe(true);
        expect(getBinderSource('galley')).toMatchObject({
            mode: 'shared',
            ownerId: 'skipper-1',
            vesselName: 'Test Boat',
            canWrite: true,
        });
        expect(galleyShareOwner()).toBe('skipper-1');

        // Once pushed it stays pushed: never asked again, and it survives a reload.
        vi.setSystemTime(new Date('2026-10-03T02:00:00.000Z'));
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(2);
        reloadSharedBindersFromStorage();
        expect(isGalleyShareLive()).toBe(true);
        expect(galleyShareOwner()).toBe('skipper-1');
    });

    it('a failed question is not an answer: it keeps what was known and asks again, never throwing', async () => {
        db.rpc.mockResolvedValue({ data: null, error: { code: '503', message: 'upstream unavailable' } });
        await expect(refreshSharedBinders()).resolves.toEqual({ changed: false, fresh: true });
        db.rpc.mockRejectedValue(new Error('Failed to fetch'));
        await expect(refreshSharedBinders()).resolves.toEqual({ changed: false, fresh: true });
        expect(isGalleyShareLive()).toBe(false);
        expect(db.rpc).toHaveBeenCalledTimes(2);
    });

    it('with no Galley ticked anywhere it asks once an hour, not every cycle', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
        db.crewRows = [];
        await refreshSharedBinders();
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-10-03T01:00:01.000Z'));
        db.rpc.mockResolvedValue(PUSHED);
        const result = await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(2);
        // Live, but nothing is shared: no forced pull.
        expect(result).toEqual({ changed: false, fresh: true });
        expect(isGalleyShareLive()).toBe(true);
        expect(getBinderSource('galley')).toEqual({ mode: 'own' });
    });

    it('a Galley tick that appears asks straight away, without waiting out the hour', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
        db.crewRows = [];
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-10-03T00:00:30.000Z'));
        db.crewRows = [membership()];
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(2);
        await refreshSharedBinders();
        expect(db.rpc).toHaveBeenCalledTimes(2);
    });

    it('a stored snapshot cannot claim a galley share the server has not confirmed', () => {
        localStorage.setItem(
            `thalassa_shared_binders_v1::user%3A${crew}`,
            JSON.stringify({
                version: 1,
                userId: crew,
                confirmedAt: '2026-10-03T00:00:00.000Z',
                skippers: [
                    {
                        ownerId: 'skipper-1',
                        vesselName: 'Test Boat',
                        lastAcceptedAt: '2026-10-02T21:00:00.000Z',
                        registers: { galley: { read: true, write: true } },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
        expect(getBinderSource('galley')).toEqual({ mode: 'own' });
    });
});
