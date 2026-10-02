/**
 * The crewing view's one read of the skipper's boat (Shane 2026-10-03: "it
 * should all pertain to the vessel that the punter has been invited on").
 *
 * loadCrewVesselView asks get_crew_vessel_view for the boat, its people and a
 * crew-safe brief. Until that migration is pushed it degrades to what RLS
 * already lets accepted crew read (boat_members names, vessel_identity). The
 * result is cached per account for a crew member reading it offline at sea.
 * Fictional boats and people only.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

interface Result {
    data: unknown;
    error: unknown;
}

const db = vi.hoisted(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    getUser: vi.fn(),
    getSession: vi.fn(),
    vessels: [] as Array<{ ownerId: string }>,
    queries: [] as Array<{ table: string; select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> }>,
    routes: {} as Record<string, Result | Promise<Result>>,
}));

function builder(table: string, result: () => Result | Promise<Result>) {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) query[method] = vi.fn(() => query);
    query.maybeSingle = vi.fn(() => Promise.resolve(result()));
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
    db.queries.push({
        table,
        select: query.select as ReturnType<typeof vi.fn>,
        eq: query.eq as ReturnType<typeof vi.fn>,
    });
    return query;
}

vi.mock('../services/supabase', () => ({
    supabase: { rpc: db.rpc, from: db.from, auth: { getUser: db.getUser, getSession: db.getSession } },
}));

vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../services/vessel/sharedBinders', () => ({
    listCrewVessels: () => db.vessels,
}));

import {
    crewRoleLabel,
    crewVesselAboard,
    crewVesselName,
    getCachedCrewVesselView,
    loadCrewVesselView,
    type CrewVesselView,
} from '../services/crew/crewVesselView';
import { useCrewVesselView } from '../hooks/useCrewVesselView';

const CACHE_KEY = 'thalassa_crew_vessel_view_v1::user%3Acrew-1';

const RPC_VIEW = {
    version: 1,
    vessel: {
        name: 'Wandering Albatross',
        type: 'sail',
        model: 'Fictional 44',
        hullColor: 'Navy',
        registration: 'TEST-123',
        mmsi: '503000999',
        callSign: 'VZZ1234',
        hailingPort: 'Example Harbour',
        crewCount: 4,
        liferaftCapacity: 6,
        liferaftServiceDate: '2026-05-01',
        flaresExpiry: '2027-02-01',
        length: 44,
        maxWindSpeed: 30,
        maxWaveHeight: 9,
    },
    vesselUnits: { length: 'ft', draft: 'm' },
    roster: [{ name: 'Ana Reyes', rank: 'Skipper' }, { name: 'Tom Okafor' }],
    manifest: [
        { isSkipper: true, isSelf: false, role: 'skipper', prefix: 'Capt', firstName: 'Ana', lastName: 'Reyes' },
        { isSkipper: false, isSelf: true, role: 'co-skipper', firstName: 'Tom', lastName: 'Okafor' },
        { isSkipper: false, isSelf: false, role: 'navigator', firstName: 'Lena', nickname: 'Lee', lastName: 'Park' },
    ],
};

function missingFunction(code: string): Result {
    return { data: null, error: { code, message: 'Could not find the function public.get_crew_vessel_view' } };
}

function installFallbackRoutes() {
    db.routes.boat_members = {
        data: [
            {
                user_id: 'skipper-1',
                role: 'owner',
                prefix: 'Capt',
                first_name: 'Ana',
                last_name: 'Reyes',
                nickname: null,
                boats: { id: 'boat-1', name: 'Wandering Albatross', owner_id: 'skipper-1', archived_at: null },
            },
            {
                user_id: 'crew-1',
                role: 'crew',
                prefix: null,
                first_name: 'Tom',
                last_name: 'Okafor',
                nickname: null,
                boats: { id: 'boat-1', name: 'Wandering Albatross', owner_id: 'skipper-1', archived_at: null },
            },
            {
                user_id: 'crew-2',
                role: 'crew',
                prefix: null,
                first_name: 'Lena',
                last_name: 'Park',
                nickname: 'Lee',
                boats: { id: 'boat-1', name: 'Wandering Albatross', owner_id: 'skipper-1', archived_at: null },
            },
        ],
        error: null,
    };
    db.routes.vessel_crew = {
        data: [
            { owner_id: 'skipper-1', crew_user_id: 'crew-1', status: 'accepted', role: 'deckhand' },
            { owner_id: 'skipper-1', crew_user_id: 'crew-1', status: 'accepted', role: 'co-skipper' },
        ],
        error: null,
    };
    db.routes.vessel_identity = {
        data: {
            id: 'identity-1',
            owner_id: 'skipper-1',
            vessel_name: 'Wandering Albatross',
            reg_number: 'TEST-123',
            mmsi: '503000999',
            call_sign: 'VZZ1234',
            phonetic_name: '',
            vessel_type: 'sail',
            hull_color: 'Navy',
            model: 'Fictional 44',
            updated_at: '2026-10-01T00:00:00.000Z',
        },
        error: null,
    };
}

beforeEach(() => {
    localStorage.clear();
    db.rpc.mockReset();
    db.from.mockReset();
    db.getUser.mockReset();
    db.getSession.mockReset();
    db.queries = [];
    db.routes = {};
    db.vessels = [{ ownerId: 'skipper-1' }];
    db.getUser.mockImplementation(async () => ({ data: { user: { id: 'crew-1' } }, error: null }));
    db.getSession.mockImplementation(async () => ({ data: { session: { user: { id: 'crew-1' } } }, error: null }));
    db.from.mockImplementation((table: string) =>
        builder(table, () => db.routes[table] ?? { data: null, error: { message: `unexpected ${table}` } }),
    );
    setAuthIdentityScope(null);
    setAuthIdentityScope('crew-1');
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('loadCrewVesselView', () => {
    it("reads the skipper's boat through the RPC and caches it for this account", async () => {
        db.rpc.mockResolvedValue({ data: RPC_VIEW, error: null });
        const result = await loadCrewVesselView('skipper-1');

        expect(db.rpc).toHaveBeenCalledWith('get_crew_vessel_view', { p_owner_id: 'skipper-1' });
        expect(result.status).toBe('fresh');
        const view = result.view!;
        expect(view.source).toBe('rpc');
        expect(view.vessel).toMatchObject({ name: 'Wandering Albatross', mmsi: '503000999', liferaftCapacity: 6 });
        // The skipper's own limits, so a crew member's weather window is the boat's.
        expect(view.vessel).toMatchObject({ maxWindSpeed: 30, maxWaveHeight: 9 });
        expect(view.vesselUnits).toEqual({ length: 'ft', draft: 'm' });
        expect(view.manifest).toEqual([
            { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
            { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom Okafor' },
            { isSkipper: false, isSelf: false, role: 'navigator', name: 'Lena "Lee" Park' },
        ]);
        // The roster keeps name and rank only; a missing rank reads as the sheet reads it.
        expect(view.roster).toEqual([
            { name: 'Ana Reyes', rank: 'Skipper' },
            { name: 'Tom Okafor', rank: 'Crew' },
        ]);
        expect(getCachedCrewVesselView('skipper-1')).toEqual(view);
        expect(Object.keys(localStorage)).toContain(CACHE_KEY);
        expect(crewVesselAboard(view)).toBe(4);
    });

    it.each(['42883', 'PGRST202'])(
        'falls back to what RLS already allows when the RPC is not pushed (%s)',
        async (code) => {
            db.rpc.mockResolvedValue(missingFunction(code));
            installFallbackRoutes();
            const result = await loadCrewVesselView('skipper-1');

            expect(result.status).toBe('fresh');
            const view = result.view!;
            expect(view.source).toBe('fallback');
            expect(view.manifest).toEqual([
                { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
                // Your own role comes from your own rows (most senior); peers read 'Crew'.
                { isSkipper: false, isSelf: false, role: 'crew', name: 'Lena "Lee" Park' },
                { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom Okafor' },
            ]);
            expect(view.vessel).toEqual({
                name: 'Wandering Albatross',
                type: 'sail',
                model: 'Fictional 44',
                hullColor: 'Navy',
                registration: 'TEST-123',
                mmsi: '503000999',
                callSign: 'VZZ1234',
            });
            expect(view.roster).toEqual([]);
            // No email column is ever read for the manifest.
            const memberSelect = db.queries.find((entry) => entry.table === 'boat_members')!.select.mock
                .calls[0][0] as string;
            expect(memberSelect).not.toMatch(/email/i);
            expect(memberSelect).toContain('boats!inner(');
            const ownRows = db.queries.find((entry) => entry.table === 'vessel_crew')!;
            expect(ownRows.eq).toHaveBeenCalledWith('crew_user_id', 'crew-1');
            expect(ownRows.eq).toHaveBeenCalledWith('owner_id', 'skipper-1');
            expect(ownRows.eq).toHaveBeenCalledWith('status', 'accepted');
            expect(ownRows.select.mock.calls[0][0]).not.toMatch(/email|permissions/);
        },
    );

    it('treats NULL as "not crew" and purges the cached boat', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        await loadCrewVesselView('skipper-1');
        expect(getCachedCrewVesselView('skipper-1')).not.toBeNull();

        db.rpc.mockResolvedValueOnce({ data: null, error: null });
        const result = await loadCrewVesselView('skipper-1');
        expect(result).toEqual({ status: 'not-crew', view: null });
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
    });

    it('in fallback mode, no accepted row of your own is "not crew" too', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        await loadCrewVesselView('skipper-1');
        db.rpc.mockResolvedValueOnce(missingFunction('PGRST202'));
        installFallbackRoutes();
        db.routes.vessel_crew = { data: [], error: null };
        const result = await loadCrewVesselView('skipper-1');
        expect(result).toEqual({ status: 'not-crew', view: null });
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
    });

    it('a network error keeps and returns the cached boat, marked stale', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        const first = await loadCrewVesselView('skipper-1');
        db.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
        const result = await loadCrewVesselView('skipper-1');
        expect(result.status).toBe('stale');
        expect(result.view).toEqual(first.view);
        expect(getCachedCrewVesselView('skipper-1')).toEqual(first.view);
    });

    it('a thrown request (offline) is stale too, never "not crew"', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        await loadCrewVesselView('skipper-1');
        db.rpc.mockRejectedValueOnce(new Error('offline'));
        const result = await loadCrewVesselView('skipper-1');
        expect(result.status).toBe('stale');
        expect(result.view?.vessel?.name).toBe('Wandering Albatross');
    });

    it('discards a result that arrives after an account switch', async () => {
        let resolve!: (value: Result) => void;
        db.rpc.mockReturnValue(
            new Promise<Result>((next) => {
                resolve = next;
            }),
        );
        const pending = loadCrewVesselView('skipper-1');
        await vi.waitFor(() => expect(db.rpc).toHaveBeenCalled());
        setAuthIdentityScope('other-1');
        resolve({ data: RPC_VIEW, error: null });
        await expect(pending).resolves.toEqual({ status: 'discarded', view: null });
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
        setAuthIdentityScope('crew-1');
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
    });

    it('refuses when Supabase says the session is a different account', async () => {
        db.getUser.mockImplementation(async () => ({ data: { user: { id: 'someone-else' } }, error: null }));
        db.getSession.mockImplementation(async () => ({
            data: { session: { user: { id: 'someone-else' } } },
            error: null,
        }));
        const result = await loadCrewVesselView('skipper-1');
        expect(result).toEqual({ status: 'discarded', view: null });
        expect(db.rpc).not.toHaveBeenCalled();
    });

    // Offline at sea the auth server cannot be reached: auth-js getUser()
    // then answers {user: null, error: AuthRetryableFetchError}. That is not
    // "signed out" and must never hide the cached boat.
    const authUnreachable = {
        data: { user: null },
        error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
    };

    it('offline (auth server unreachable): the cached boat stands, marked stale', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        const first = await loadCrewVesselView('skipper-1');
        db.getUser.mockImplementation(async () => authUnreachable);
        db.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const result = await loadCrewVesselView('skipper-1');
        expect(result.status).toBe('stale');
        expect(result.view).toEqual(first.view);
        expect(getCachedCrewVesselView('skipper-1')).toEqual(first.view);
    });

    it('a session that cannot be refreshed offline is stale too, never discarded', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        const first = await loadCrewVesselView('skipper-1');
        db.getUser.mockImplementation(async () => authUnreachable);
        db.getSession.mockImplementation(async () => ({
            data: { session: null },
            error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
        }));
        const result = await loadCrewVesselView('skipper-1');
        expect(result).toEqual({ status: 'stale', view: first.view });
    });

    it('no session on this device is discarded, and the server is not asked', async () => {
        db.getUser.mockImplementation(async () => ({
            data: { user: null },
            error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' },
        }));
        db.getSession.mockImplementation(async () => ({ data: { session: null }, error: null }));
        await expect(loadCrewVesselView('skipper-1')).resolves.toEqual({ status: 'discarded', view: null });
        expect(db.rpc).not.toHaveBeenCalled();
    });

    it('a degraded read keeps the hull name alone when the identity row is another boat', async () => {
        // The skipper switched the active boat after crew accepted: the crew
        // stay bridged on Petrel while vessel_identity now projects Kestrel.
        db.rpc.mockResolvedValue(missingFunction('PGRST202'));
        installFallbackRoutes();
        const members = db.routes.boat_members as Result;
        db.routes.boat_members = {
            data: (members.data as Array<Record<string, unknown>>).map((row) => ({
                ...row,
                boats: { id: 'boat-1', name: 'Petrel', owner_id: 'skipper-1', archived_at: null },
            })),
            error: null,
        };
        const identity = db.routes.vessel_identity as Result;
        db.routes.vessel_identity = {
            data: { ...(identity.data as Record<string, unknown>), vessel_name: 'Kestrel', mmsi: '503000111' },
            error: null,
        };
        const result = await loadCrewVesselView('skipper-1');
        expect(result.view?.vessel).toEqual({ name: 'Petrel' });

        // The same boat by name (any case or spacing) still gets its identification.
        db.routes.vessel_identity = {
            data: { ...(identity.data as Record<string, unknown>), vessel_name: '  petrel ', mmsi: '503000111' },
            error: null,
        };
        const matched = await loadCrewVesselView('skipper-1');
        expect(matched.view?.vessel).toMatchObject({ name: 'Petrel', mmsi: '503000111', registration: 'TEST-123' });
    });

    it('never lets a key outside the allow-list reach the view or the cache', async () => {
        db.rpc.mockResolvedValue({
            data: {
                ...RPC_VIEW,
                ownerEmail: 'skipper@example.com',
                vessel: {
                    ...RPC_VIEW.vessel,
                    epirbHexId: 'ABCDEF0123456',
                    shoreContact1: 'Jo Example 0400 000 000',
                    shoreContact2: 'Marina office',
                    contactPhone: '0400 000 001',
                    satPhone: '+870 000 000',
                    safetyNotes: 'PLB x2',
                    crewRoster: [{ name: 'Ana Reyes', age: 51 }],
                },
                vesselUnits: { length: 'ft', secret: 'x' },
                roster: [{ name: 'Ana Reyes', rank: 'Skipper', age: 51 }],
                manifest: [
                    {
                        ...RPC_VIEW.manifest[0],
                        email: 'skipper@example.com',
                        crew_email: 'skipper@example.com',
                        userId: 'skipper-1',
                    },
                ],
            },
            error: null,
        });
        const result = await loadCrewVesselView('skipper-1');
        const serialised = JSON.stringify(result.view);
        const cached = localStorage.getItem(CACHE_KEY) ?? '';
        for (const forbidden of [
            'epirbHexId',
            'shoreContact',
            'contactPhone',
            'satPhone',
            'safetyNotes',
            'crewRoster',
            '"age"',
            'email',
            'example.com',
            'secret',
            'userId',
        ]) {
            expect(serialised).not.toContain(forbidden);
            expect(cached).not.toContain(forbidden);
        }
        expect(result.view?.manifest[0]).toEqual({
            isSkipper: true,
            isSelf: false,
            role: 'skipper',
            name: 'Capt Ana Reyes',
        });
    });

    it('keeps one cache per account and prunes boats the sailor no longer crews on', async () => {
        db.vessels = [{ ownerId: 'skipper-1' }, { ownerId: 'skipper-2' }];
        db.rpc.mockResolvedValue({ data: RPC_VIEW, error: null });
        await loadCrewVesselView('skipper-2');
        await loadCrewVesselView('skipper-1');
        expect(getCachedCrewVesselView('skipper-2')).not.toBeNull();

        db.vessels = [{ ownerId: 'skipper-1' }];
        await loadCrewVesselView('skipper-1');
        expect(getCachedCrewVesselView('skipper-2')).toBeNull();
        expect(getCachedCrewVesselView('skipper-1')).not.toBeNull();

        setAuthIdentityScope('other-1');
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
        // A cache copied under another account's key is never read for it.
        localStorage.setItem('thalassa_crew_vessel_view_v1::user%3Aother-1', localStorage.getItem(CACHE_KEY)!);
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
    });

    it('does nothing while signed out', async () => {
        setAuthIdentityScope(null);
        await expect(loadCrewVesselView('skipper-1')).resolves.toEqual({ status: 'discarded', view: null });
        expect(db.rpc).not.toHaveBeenCalled();
        expect(getCachedCrewVesselView('skipper-1')).toBeNull();
    });
});

describe('useCrewVesselView offline', () => {
    const authUnreachable = {
        data: { user: null },
        error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
    };

    it('shows the cached boat marked stale when the server cannot be reached', async () => {
        db.rpc.mockResolvedValueOnce({ data: RPC_VIEW, error: null });
        await loadCrewVesselView('skipper-1');
        db.getUser.mockImplementation(async () => authUnreachable);
        db.rpc.mockRejectedValue(new TypeError('Failed to fetch'));

        const { result } = renderHook(() => useCrewVesselView('skipper-1'));
        expect(result.current.view?.vessel?.name).toBe('Wandering Albatross');
        await waitFor(() => expect(result.current.stale).toBe(true));
        expect(result.current.loading).toBe(false);
    });

    it('with nothing cached, stops loading once the server cannot be reached', async () => {
        db.getUser.mockImplementation(async () => authUnreachable);
        db.rpc.mockRejectedValue(new TypeError('Failed to fetch'));

        const { result } = renderHook(() => useCrewVesselView('skipper-1'));
        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.view).toBeNull();
    });

    it('a discarded answer for the same account still ends loading', async () => {
        db.getUser.mockImplementation(async () => ({ data: { user: null }, error: null }));
        db.getSession.mockImplementation(async () => ({ data: { session: null }, error: null }));

        const { result } = renderHook(() => useCrewVesselView('skipper-1'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.view).toBeNull();
        expect(db.rpc).not.toHaveBeenCalled();
    });
});

describe('crew labels', () => {
    it('names each role the way the invite picker does', () => {
        expect(crewRoleLabel('co-skipper')).toBe('Co-skipper');
        expect(crewRoleLabel('navigator')).toBe('Navigator');
        expect(crewRoleLabel('deckhand')).toBe('Deckhand');
        expect(crewRoleLabel('punter')).toBe('Punter');
        expect(crewRoleLabel('skipper')).toBe('Skipper');
        expect(crewRoleLabel('crew')).toBe('Crew');
        expect(crewRoleLabel(null)).toBe('Crew');
        expect(crewRoleLabel('something-new')).toBe('Crew');
    });

    it("names the boat after the view's hull, not the skipper's selected boat", () => {
        const view = (name: string | undefined, source: CrewVesselView['source']): CrewVesselView => ({
            ownerId: 'skipper-1',
            vessel: name ? { name } : null,
            vesselUnits: null,
            roster: [],
            manifest: [],
            fetchedAt: '2026-10-03T00:00:00.000Z',
            source,
        });
        // vessel_identity (the snapshot's name) follows the skipper's SELECTED
        // boat; the view names the hull this crew member is actually on.
        expect(crewVesselName('Kestrel', view('Petrel', 'rpc'))).toBe('Petrel');
        expect(crewVesselName('Kestrel', view('Petrel', 'fallback'))).toBe('Petrel');
        expect(crewVesselName('Kestrel', view(undefined, 'rpc'))).toBe('Kestrel');
        expect(crewVesselName('Kestrel', null)).toBe('Kestrel');
        expect(crewVesselName(null, null)).toBeNull();
        expect(crewVesselName('  ', view('  ', 'rpc'))).toBeNull();
    });

    it('counts souls aboard as the larger of the profile count and the app crew', () => {
        expect(crewVesselAboard(null)).toBeNull();
        expect(
            crewVesselAboard({
                ownerId: 'skipper-1',
                vessel: { name: 'Wandering Albatross', crewCount: 2 },
                vesselUnits: null,
                roster: [],
                manifest: [
                    { isSkipper: true, isSelf: false, role: 'skipper', name: 'Ana' },
                    { isSkipper: false, isSelf: true, role: 'deckhand', name: 'Tom' },
                    { isSkipper: false, isSelf: false, role: 'crew', name: 'Lena' },
                ],
                fetchedAt: '2026-10-03T00:00:00.000Z',
                source: 'rpc',
            }),
        ).toBe(3);
    });
});
