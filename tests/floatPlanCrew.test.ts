/**
 * floatPlanCrew — the Float Plan roster's crew-list seed (Shane 2026-09-08:
 * "scrape the names of crew from the invites").
 *
 * Pure grammar and role mapping first; then loadFloatPlanCrew against a
 * file-local Supabase mock so the queries it issues can be inspected — the
 * skipper lands first, accepted crew are named from boat_members in ONE
 * `.in()` query, pending invites become chips, declined rows vanish, and any
 * failure or identity change returns null rather than a wrong roster.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const supabaseMocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
}));

const boatMocks = vi.hoisted(() => ({
    activeOwnedBoatId: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: supabaseMocks.getUser },
        from: supabaseMocks.from,
    },
}));

vi.mock('../components/crewManagement/activeOwnedBoat', () => ({
    activeOwnedBoatId: boatMocks.activeOwnedBoatId,
}));

import { crewRoleToFloatPlanRole, loadFloatPlanCrew, renderCrewDisplayName } from '../services/floatPlanCrew';

const OWNER = 'owner-1';

/** A thenable query builder: every filter returns itself, `await` yields `result`. */
function queryBuilder(result: { data: unknown; error: { message: string } | null }) {
    const builder: Record<string, ReturnType<typeof vi.fn>> & {
        then?: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
    } = {};
    for (const method of ['select', 'eq', 'in', 'order', 'neq', 'limit']) {
        builder[method] = vi.fn(() => builder);
    }
    builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return builder;
}

function crewRow(overrides: Partial<Record<string, unknown>>) {
    return {
        id: `crew-${Math.random().toString(36).slice(2, 8)}`,
        crew_user_id: null,
        crew_email: null,
        status: 'accepted',
        role: 'deckhand',
        voyage_id: null,
        ...overrides,
    };
}

function signedInAs(userId: string, metadata: Record<string, string> = {}) {
    setAuthIdentityScope(userId);
    supabaseMocks.getUser.mockResolvedValue({
        data: { user: { id: userId, email: 'skipper@example.com', user_metadata: metadata } },
        error: null,
    });
}

function tables(config: {
    crew: { data: unknown; error: { message: string } | null };
    members: { data: unknown; error: { message: string } | null };
}) {
    const crew = queryBuilder(config.crew);
    const members = queryBuilder(config.members);
    supabaseMocks.from.mockImplementation((table: string) => {
        if (table === 'vessel_crew') return crew;
        if (table === 'boat_members') return members;
        throw new Error(`unexpected table ${table}`);
    });
    return { crew, members };
}

describe('renderCrewDisplayName', () => {
    it('renders prefix, first, "nickname", last — single-spaced and trimmed', () => {
        expect(
            renderCrewDisplayName({
                prefix: ' Capt. ',
                first_name: 'Shane',
                nickname: 'Skip',
                last_name: '  Stratton ',
            }),
        ).toBe('Capt. Shane "Skip" Stratton');
        expect(renderCrewDisplayName({ first_name: 'Marta', last_name: 'Kowalski' })).toBe('Marta Kowalski');
        expect(renderCrewDisplayName({ first_name: 'Marta', nickname: 'M' })).toBe('Marta "M"');
        expect(renderCrewDisplayName({ prefix: 'Dr.', first_name: 'Anne   Marie' })).toBe('Dr. Anne Marie');
    });

    it('falls back to the Title Cased email local part with dots and underscores as spaces', () => {
        expect(renderCrewDisplayName(null, 'marta.k@example.com')).toBe('Marta K');
        expect(renderCrewDisplayName(undefined, 'john_smith@example.com')).toBe('John Smith');
        expect(renderCrewDisplayName({ first_name: '  ' }, 'anne-marie.jones@example.com')).toBe('Anne-Marie Jones');
        expect(renderCrewDisplayName({}, 'SHANE@example.com')).toBe('Shane');
    });

    it('is empty when there is nothing to render — never a placeholder', () => {
        expect(renderCrewDisplayName(null)).toBe('');
        expect(renderCrewDisplayName({ prefix: null, first_name: null, last_name: null, nickname: null }, '')).toBe('');
        expect(renderCrewDisplayName(undefined, '@example.com')).toBe('');
    });
});

describe('crewRoleToFloatPlanRole', () => {
    it('maps the invite roles onto the roster roles a coordinator recognises', () => {
        expect(crewRoleToFloatPlanRole('co-skipper')).toBe('First mate');
        expect(crewRoleToFloatPlanRole('navigator')).toBe('Navigator');
        expect(crewRoleToFloatPlanRole('deckhand')).toBe('Deckhand');
        expect(crewRoleToFloatPlanRole('punter')).toBe('Guest');
    });

    it('is Crew for anything it does not know', () => {
        expect(crewRoleToFloatPlanRole('')).toBe('Crew');
        expect(crewRoleToFloatPlanRole('bosun')).toBe('Crew');
    });
});

describe('loadFloatPlanCrew', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        signedInAs(OWNER, { first_name: 'Shane', last_name: 'Stratton' });
        boatMocks.activeOwnedBoatId.mockResolvedValue('boat-1');
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('puts the skipper first, names accepted crew from boat_members, offers pending as invites, drops declined', async () => {
        const { crew, members } = tables({
            crew: {
                data: [
                    crewRow({ crew_user_id: 'u-marta', crew_email: 'marta.k@example.com', role: 'co-skipper' }),
                    crewRow({
                        crew_user_id: 'u-tom',
                        crew_email: 'tom@example.com',
                        role: 'punter',
                        status: 'pending',
                    }),
                    crewRow({ crew_user_id: 'u-gone', crew_email: 'gone@example.com', status: 'declined' }),
                    crewRow({ crew_user_id: null, crew_email: 'new.deckie@example.com', status: 'pending' }),
                ],
                error: null,
            },
            members: {
                data: [
                    { user_id: OWNER, prefix: 'Capt.', first_name: 'Shane', last_name: 'Stratton', nickname: null },
                    { user_id: 'u-marta', prefix: null, first_name: 'Marta', last_name: 'Kowalski', nickname: 'M' },
                ],
                error: null,
            },
        });

        const result = await loadFloatPlanCrew(null);

        expect(result).not.toBeNull();
        expect(result!.aboard).toEqual([
            { name: 'Capt. Shane Stratton', role: 'Skipper', source: 'skipper', crewUserId: OWNER },
            { name: 'Marta "M" Kowalski', role: 'First mate', source: 'crew', crewUserId: 'u-marta' },
        ]);
        expect(result!.invited).toEqual([
            { name: 'Tom', role: 'Guest', source: 'invite', crewUserId: 'u-tom' },
            { name: 'New Deckie', role: 'Deckhand', source: 'invite', crewUserId: null },
        ]);

        // Owner-filtered crew read; one boat_members read for every id at once.
        expect(crew.eq).toHaveBeenCalledWith('owner_id', OWNER);
        expect(members.eq).toHaveBeenCalledWith('boat_id', 'boat-1');
        expect(members.in).toHaveBeenCalledTimes(1);
        expect(members.in).toHaveBeenCalledWith('user_id', [OWNER, 'u-marta', 'u-tom']);
        expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'boat_members')).toHaveLength(1);
    });

    it('includes rows scoped to THIS voyage, excludes other voyages, and lists a person once', async () => {
        tables({
            crew: {
                data: [
                    crewRow({ crew_user_id: 'u-marta', crew_email: 'marta@example.com', voyage_id: null }),
                    crewRow({ crew_user_id: 'u-marta', crew_email: 'marta@example.com', voyage_id: 'v-1' }),
                    crewRow({
                        crew_user_id: 'u-lee',
                        crew_email: 'lee@example.com',
                        voyage_id: 'v-1',
                        role: 'navigator',
                    }),
                    crewRow({ crew_user_id: 'u-other', crew_email: 'other@example.com', voyage_id: 'v-99' }),
                    // Accepted globally, still pending for this voyage — aboard, not a chip.
                    crewRow({
                        crew_user_id: 'u-lee',
                        crew_email: 'lee@example.com',
                        voyage_id: 'v-1',
                        status: 'pending',
                    }),
                ],
                error: null,
            },
            members: { data: [], error: null },
        });

        const result = await loadFloatPlanCrew('v-1');

        expect(result!.aboard.map((seed) => seed.name)).toEqual(['Shane Stratton', 'Marta', 'Lee']);
        expect(result!.aboard[2]).toMatchObject({ role: 'Navigator', source: 'crew' });
        expect(result!.invited).toEqual([]);
    });

    it('names the skipper from auth metadata when there is no boat_members row, and leaves it empty otherwise', async () => {
        tables({ crew: { data: [], error: null }, members: { data: [], error: null } });
        const withMeta = await loadFloatPlanCrew();
        expect(withMeta!.aboard).toEqual([
            { name: 'Shane Stratton', role: 'Skipper', source: 'skipper', crewUserId: OWNER },
        ]);

        signedInAs(OWNER, {});
        const noMeta = await loadFloatPlanCrew();
        expect(noMeta!.aboard).toEqual([{ name: '', role: 'Skipper', source: 'skipper', crewUserId: OWNER }]);

        // A legacy owner row with no name parts is not a name — metadata still wins.
        signedInAs(OWNER, { first_name: 'Shane', last_name: 'Stratton' });
        tables({
            crew: { data: [], error: null },
            members: {
                data: [{ user_id: OWNER, prefix: null, first_name: null, last_name: null, nickname: null }],
                error: null,
            },
        });
        const emptyRow = await loadFloatPlanCrew();
        expect(emptyRow!.aboard[0].name).toBe('Shane Stratton');
    });

    it('falls back to emails when the skipper has no boat yet, without touching boat_members', async () => {
        boatMocks.activeOwnedBoatId.mockResolvedValue(null);
        const { members } = tables({
            crew: {
                data: [crewRow({ crew_user_id: 'u-marta', crew_email: 'marta.k@example.com' })],
                error: null,
            },
            members: { data: [], error: null },
        });

        const result = await loadFloatPlanCrew();

        expect(result!.aboard.map((seed) => seed.name)).toEqual(['Shane Stratton', 'Marta K']);
        expect(members.in).not.toHaveBeenCalled();
    });

    it('is null when signed out, before any query', async () => {
        setAuthIdentityScope(null);
        tables({ crew: { data: [], error: null }, members: { data: [], error: null } });

        expect(await loadFloatPlanCrew()).toBeNull();
        expect(supabaseMocks.getUser).not.toHaveBeenCalled();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('is null when Supabase no longer represents the fenced user', async () => {
        supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } }, error: null });
        tables({ crew: { data: [], error: null }, members: { data: [], error: null } });

        expect(await loadFloatPlanCrew()).toBeNull();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('is null when the identity changes mid-flight', async () => {
        boatMocks.activeOwnedBoatId.mockImplementation(async () => {
            setAuthIdentityScope('next-account');
            return 'boat-1';
        });
        tables({ crew: { data: [], error: null }, members: { data: [], error: null } });

        expect(await loadFloatPlanCrew()).toBeNull();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('is null on a vessel_crew error or a boat_members error, and on a thrown failure', async () => {
        tables({ crew: { data: null, error: { message: 'rls' } }, members: { data: [], error: null } });
        expect(await loadFloatPlanCrew()).toBeNull();

        tables({
            crew: { data: [crewRow({ crew_user_id: 'u-marta', crew_email: 'm@example.com' })], error: null },
            members: { data: null, error: { message: 'boom' } },
        });
        expect(await loadFloatPlanCrew()).toBeNull();

        supabaseMocks.getUser.mockRejectedValue(new Error('offline'));
        expect(await loadFloatPlanCrew()).toBeNull();
    });
});
