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

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { readFileSync } from 'node:fs';
import { aboardCount, CREW_ROLE_SENIORITY } from '../services/crew/floatPlanPeople';

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

import {
    crewRoleToFloatPlanRole,
    loadFloatPlanCrew,
    mergeProfileWithCrew,
    renderCrewDisplayName,
    rosterSeedsFromVesselProfile,
} from '../services/floatPlanCrew';

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
    details?: { data: unknown; error: { message: string; code?: string } | null };
    voyages?: { data: unknown; error: { message: string; code?: string } | null };
}) {
    const crew = queryBuilder(config.crew);
    const members = queryBuilder(config.members);
    const details = queryBuilder(config.details ?? { data: [], error: null });
    const voyages = queryBuilder(config.voyages ?? { data: [], error: null });
    supabaseMocks.from.mockImplementation((table: string) => {
        if (table === 'vessel_crew') return crew;
        if (table === 'boat_members') return members;
        if (table === 'crew_float_plan_details') return details;
        if (table === 'voyages') return voyages;
        throw new Error(`unexpected table ${table}`);
    });
    return { crew, members, details, voyages };
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
        // The invite picker's own word (Shane 2026-10-06: "captain, first mate
        // and co captain"): a co-skipper is not the profile's First mate.
        expect(crewRoleToFloatPlanRole('co-skipper')).toBe('Co-skipper');
        expect(crewRoleToFloatPlanRole('navigator')).toBe('Navigator');
        expect(crewRoleToFloatPlanRole('deckhand')).toBe('Deckhand');
        expect(crewRoleToFloatPlanRole('punter')).toBe('Guest');
    });

    it('is Crew for anything it does not know', () => {
        expect(crewRoleToFloatPlanRole('')).toBe('Crew');
        expect(crewRoleToFloatPlanRole('bosun')).toBe('Crew');
    });
});

describe('CREW_ROLE_SENIORITY', () => {
    it('ranks the roles exactly as get_crew_vessel_view does, so both devices pick the same role', () => {
        // One map for the skipper's float plan, the crew's own view of the
        // boat and the shared binders (review 2026-10-06: it had four copies).
        const sql = readFileSync('supabase/migrations/20261003120000_crew_vessel_view.sql', 'utf8');
        const ranks = Object.fromEntries(
            [...sql.matchAll(/WHEN '([a-z-]+)' THEN (\d+)/g)].map(([, role, rank]) => [role, Number(rank)]),
        );
        expect(ranks).toEqual({ ...CREW_ROLE_SENIORITY });
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
            { name: 'Marta "M" Kowalski', role: 'Co-skipper', source: 'crew', crewUserId: 'u-marta' },
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

    it('lists accepted crew whatever passage their invite named, each once, and offers only this passage’s invites', async () => {
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
                    // Accepted for another passage: the invite's passage is what they
                    // may see (chat, route, meals), not whether they are aboard.
                    crewRow({ crew_user_id: 'u-other', crew_email: 'other@example.com', voyage_id: 'v-99' }),
                    // Accepted globally, still pending for this voyage — aboard, not a chip.
                    crewRow({
                        crew_user_id: 'u-lee',
                        crew_email: 'lee@example.com',
                        voyage_id: 'v-1',
                        status: 'pending',
                    }),
                    // Pending for another passage: not offered on this one.
                    crewRow({
                        crew_user_id: 'u-later',
                        crew_email: 'later@example.com',
                        voyage_id: 'v-99',
                        status: 'pending',
                    }),
                ],
                error: null,
            },
            members: { data: [], error: null },
        });

        const result = await loadFloatPlanCrew('v-1');

        expect(result!.aboard.map((seed) => seed.name)).toEqual(['Shane Stratton', 'Marta', 'Lee', 'Other']);
        expect(result!.aboard[2]).toMatchObject({ role: 'Navigator', source: 'crew' });
        expect(result!.invited).toEqual([]);
    });

    describe('an invitee accepted for one passage, on the float plan of another (Shane 2026-10-06)', () => {
        // The production shape, with fictional people (the repository is public):
        // ONE accepted vessel_crew row, role co-skipper, scoped to a passage that
        // has since finished; their own name and age shared, no phone.
        const scoped = {
            data: [
                crewRow({
                    crew_user_id: 'u-tom',
                    crew_email: 'tom.o@example.com',
                    role: 'co-skipper',
                    voyage_id: 'voyage-finished',
                }),
            ],
            error: null,
        };
        const details = {
            data: [{ user_id: 'u-tom', full_name: 'Tom Okafor', phone: null, age: 41 }],
            error: null,
        };
        beforeEach(() => {
            signedInAs(OWNER, { first_name: 'Ana', last_name: 'Reyes' });
        });

        it.each([
            ['the passage planner (no voyage yet)', null, 'Magnetic Island day sail'],
            ['Cast Off on another passage', 'voyage-next', 'Magnetic Island day sail'],
            ['the passage the invite named', 'voyage-finished', undefined],
        ])('is aboard from %s, as a Co-skipper with their own name and age', async (_from, voyageId, invitedFor) => {
            tables({
                crew: scoped,
                members: {
                    data: [{ user_id: 'u-tom', prefix: null, first_name: 'Tom', last_name: 'O', nickname: null }],
                    error: null,
                },
                details,
                voyages: {
                    data: [
                        {
                            id: 'voyage-finished',
                            voyage_name: 'Magnetic Island day sail',
                            departure_port: null,
                            destination_port: null,
                        },
                    ],
                    error: null,
                },
            });

            const result = await loadFloatPlanCrew(voyageId);

            expect(result!.aboard).toEqual([
                { name: 'Ana Reyes', role: 'Skipper', source: 'skipper', crewUserId: OWNER },
                {
                    name: 'Tom Okafor',
                    role: 'Co-skipper',
                    source: 'crew',
                    crewUserId: 'u-tom',
                    shared: { name: 'Tom Okafor', phone: null, age: 41, appName: 'Tom O' },
                    // Said aloud on the plan when it is not this plan's passage (review 2026-10-06).
                    ...(invitedFor ? { invitedFor } : {}),
                },
            ]);
            expect(result!.invited).toEqual([]);
        });

        it("joins the skipper's Skipper and First mate: three aboard, each once, in rank order", async () => {
            tables({ crew: scoped, members: { data: [], error: null }, details });
            const profile = rosterSeedsFromVesselProfile({
                crewRoster: [
                    { name: 'Ana Reyes', age: 52, rank: 'Skipper' },
                    { name: 'Priya Nair', age: 38, rank: 'First mate' },
                ],
            });

            const merged = mergeProfileWithCrew(profile, (await loadFloatPlanCrew(null))!.aboard);

            // Shane 2026-10-07: "order the punters on board by their rank" — the
            // co-skipper invitee is second, above the profile's First mate.
            expect(merged.map((person) => [person.name, person.role, person.age, person.added])).toEqual([
                ['Ana Reyes', 'Skipper', 52, false],
                ['Tom Okafor', 'Co-skipper', 41, true],
                ['Priya Nair', 'First mate', 38, false],
            ]);
            expect(aboardCount(merged.length, undefined)).toBe(3);
        });

        it('is one person when the skipper also typed them into his own list', async () => {
            tables({ crew: scoped, members: { data: [], error: null }, details });
            const profile = rosterSeedsFromVesselProfile({
                crewRoster: [
                    { name: 'Ana Reyes', age: 52, rank: 'Skipper' },
                    { name: 'Priya Nair', age: 38, rank: 'First mate' },
                    { name: 'Tom', rank: 'Crew' },
                ],
            });

            const merged = mergeProfileWithCrew(profile, (await loadFloatPlanCrew(null))!.aboard);

            // His own name and age; the rank the skipper chose for him stands.
            expect(merged.map((person) => [person.name, person.role, person.age])).toEqual([
                ['Ana Reyes', 'Skipper', 52],
                ['Priya Nair', 'First mate', 38],
                ['Tom Okafor', 'Crew', 41],
            ]);
        });

        it('takes the most senior role when one person holds rows for several passages', async () => {
            tables({
                crew: {
                    data: [
                        crewRow({ crew_user_id: 'u-tom', crew_email: 'tom.o@example.com', role: 'deckhand' }),
                        crewRow({
                            crew_user_id: 'u-tom',
                            crew_email: 'tom.o@example.com',
                            role: 'co-skipper',
                            voyage_id: 'voyage-finished',
                        }),
                    ],
                    error: null,
                },
                members: { data: [], error: null },
            });

            const result = await loadFloatPlanCrew(null);

            expect(result!.aboard.map((seed) => [seed.crewUserId, seed.role])).toEqual([
                [OWNER, 'Skipper'],
                ['u-tom', 'Co-skipper'],
            ]);
        });
    });

    describe('names the passage an invite was for, when it is not this plan’s (review 2026-10-06)', () => {
        // Accepted crew are aboard whatever passage their invite named, so a
        // one-off day-sail guest would otherwise ride along on every later
        // plan without a word. The plan says which passage they came from.
        const voyageRow = (id: string, voyage_name: string, departure_port = null, destination_port = null) => ({
            id,
            voyage_name,
            departure_port,
            destination_port,
        });

        it("from the skipper's own voyages, in one read, only for crew invited elsewhere", async () => {
            const { voyages } = tables({
                crew: {
                    data: [
                        crewRow({ crew_user_id: 'u-tom', role: 'co-skipper', voyage_id: 'voyage-finished' }),
                        crewRow({ crew_user_id: 'u-sam', role: 'punter', voyage_id: 'voyage-daysail' }),
                        crewRow({ crew_user_id: 'u-lee', role: 'deckhand' }),
                        crewRow({ crew_user_id: 'u-jo', role: 'navigator', voyage_id: 'voyage-next' }),
                    ],
                    error: null,
                },
                members: { data: [], error: null },
                voyages: {
                    data: [
                        voyageRow('voyage-finished', 'Magnetic Island day sail'),
                        {
                            id: 'voyage-daysail',
                            voyage_name: '',
                            departure_port: 'Townsville',
                            destination_port: 'Orpheus Island',
                        },
                    ],
                    error: null,
                },
            });

            const result = await loadFloatPlanCrew('voyage-next');

            expect(voyages.select).toHaveBeenCalledWith('id, voyage_name, departure_port, destination_port');
            expect(voyages.eq).toHaveBeenCalledWith('user_id', OWNER);
            expect(voyages.in).toHaveBeenCalledWith('id', ['voyage-finished', 'voyage-daysail']);
            expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'voyages')).toHaveLength(1);
            expect(result!.aboard.map((seed) => [seed.crewUserId, seed.invitedFor])).toEqual([
                [OWNER, undefined],
                ['u-tom', 'Magnetic Island day sail'],
                ['u-sam', 'Townsville → Orpheus Island'],
                ['u-lee', undefined],
                ['u-jo', undefined],
            ]);
            expect(result!.aboard.filter((seed) => 'invitedFor' in seed)).toHaveLength(2);
        });

        it('says nothing for crew who also hold an every-passage or this-passage invite', async () => {
            const { voyages } = tables({
                crew: {
                    data: [
                        crewRow({ crew_user_id: 'u-tom', role: 'co-skipper', voyage_id: 'voyage-finished' }),
                        crewRow({ crew_user_id: 'u-tom', role: 'deckhand' }),
                        crewRow({ crew_user_id: 'u-sam', role: 'punter', voyage_id: 'voyage-daysail' }),
                        crewRow({ crew_user_id: 'u-sam', role: 'punter', voyage_id: 'voyage-next' }),
                    ],
                    error: null,
                },
                members: { data: [], error: null },
            });

            const result = await loadFloatPlanCrew('voyage-next');

            expect(result!.aboard.map((seed) => [seed.crewUserId, seed.role, seed.invitedFor])).toEqual([
                [OWNER, 'Skipper', undefined],
                ['u-tom', 'Co-skipper', undefined],
                ['u-sam', 'Guest', undefined],
            ]);
            expect(voyages.select).not.toHaveBeenCalled();
        });

        it('names the latest of several other passages', async () => {
            tables({
                crew: {
                    data: [
                        crewRow({ crew_user_id: 'u-sam', role: 'punter', voyage_id: 'voyage-old' }),
                        crewRow({ crew_user_id: 'u-sam', role: 'punter', voyage_id: 'voyage-daysail' }),
                    ],
                    error: null,
                },
                members: { data: [], error: null },
                voyages: {
                    data: [
                        voyageRow('voyage-old', 'Winter delivery run'),
                        voyageRow('voyage-daysail', 'Orpheus day sail'),
                    ],
                    error: null,
                },
            });

            const result = await loadFloatPlanCrew(null);

            expect(result!.aboard[1].invitedFor).toBe('Orpheus day sail');
        });

        it('reads "another passage" when the voyage is gone, unnamed or unreadable, and the plan still loads', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            onTestFinished(() => warn.mockRestore());
            const rows = {
                data: [crewRow({ crew_user_id: 'u-tom', role: 'co-skipper', voyage_id: 'voyage-finished' })],
                error: null,
            };

            tables({ crew: rows, members: { data: [], error: null }, voyages: { data: [], error: null } });
            expect((await loadFloatPlanCrew(null))!.aboard[1].invitedFor).toBe('another passage');

            tables({
                crew: rows,
                members: { data: [], error: null },
                voyages: { data: [voyageRow('voyage-finished', '  ')], error: null },
            });
            expect((await loadFloatPlanCrew(null))!.aboard[1].invitedFor).toBe('another passage');
            expect(warn).not.toHaveBeenCalled();

            tables({
                crew: rows,
                members: { data: [], error: null },
                voyages: { data: null, error: { message: 'permission denied' } },
            });
            const failed = await loadFloatPlanCrew(null);
            expect(failed!.aboard.map((seed) => [seed.crewUserId, seed.invitedFor])).toEqual([
                [OWNER, undefined],
                ['u-tom', 'another passage'],
            ]);
            expect(warn).toHaveBeenCalledWith(
                '[floatPlanCrew]',
                'float plan crew: passage names read failed',
                'permission denied',
            );

            const builders = tables({ crew: rows, members: { data: [], error: null } });
            builders.voyages.in.mockImplementation(() => {
                throw new Error('offline');
            });
            const thrown = await loadFloatPlanCrew(null);
            expect(thrown!.aboard[1].invitedFor).toBe('another passage');
        });
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

    describe("an invitee's own name, phone and age (Shane 2026-10-04)", () => {
        const crewRows = {
            data: [
                crewRow({ crew_user_id: 'u-tom', crew_email: 'tom.o@example.com', role: 'deckhand' }),
                crewRow({ crew_user_id: 'u-lee', crew_email: 'lee@example.com', role: 'navigator' }),
                crewRow({ crew_user_id: 'u-pending', crew_email: 'p@example.com', status: 'pending' }),
            ],
            error: null,
        };
        // A fictional skipper: the repository is public.
        beforeEach(() => {
            signedInAs(OWNER, { first_name: 'Ana', last_name: 'Reyes' });
        });

        it('reads what accepted crew shared, for accepted crew only, and their own name wins', async () => {
            const { details } = tables({
                crew: crewRows,
                members: { data: [], error: null },
                details: {
                    data: [{ user_id: 'u-tom', full_name: 'Thomas Okafor', phone: '0491 570 156', age: 34 }],
                    error: null,
                },
            });

            const result = await loadFloatPlanCrew();

            expect(details.select).toHaveBeenCalledWith('user_id, full_name, phone, age');
            expect(details.in).toHaveBeenCalledWith('user_id', ['u-tom', 'u-lee']);
            expect(result!.aboard[1]).toEqual({
                name: 'Thomas Okafor',
                role: 'Deckhand',
                source: 'crew',
                crewUserId: 'u-tom',
                shared: { name: 'Thomas Okafor', phone: '0491 570 156', age: 34, appName: 'Tom O' },
            });
            // Nothing shared: the app's name, and no phone or age.
            expect(result!.aboard[2]).toEqual({ name: 'Lee', role: 'Navigator', source: 'crew', crewUserId: 'u-lee' });
        });

        it.each(['PGRST205', '42P01', 'PGRST202', '42883'])(
            'is quiet before the migration is pushed (%s): no warning, the names stand',
            async (code) => {
                const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
                tables({
                    crew: crewRows,
                    members: { data: [], error: null },
                    details: { data: null, error: { message: 'not there yet', code } },
                });
                const result = await loadFloatPlanCrew();
                expect(result!.aboard.map((seed) => seed.name)).toEqual(['Ana Reyes', 'Tom O', 'Lee']);
                expect(warn).not.toHaveBeenCalled();
                warn.mockRestore();
            },
        );

        it('says why when the details read fails for any other reason', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            tables({
                crew: crewRows,
                members: { data: [], error: null },
                details: { data: null, error: { message: 'permission denied', code: '42501' } },
            });
            const result = await loadFloatPlanCrew();
            expect(result!.aboard.map((seed) => seed.name)).toEqual(['Ana Reyes', 'Tom O', 'Lee']);
            expect(warn).toHaveBeenCalledWith(
                '[floatPlanCrew]',
                'float plan crew: shared details read failed',
                'permission denied',
            );
            warn.mockRestore();
        });

        it('skips the read when nobody has accepted', async () => {
            const { details } = tables({ crew: { data: [], error: null }, members: { data: [], error: null } });
            await loadFloatPlanCrew();
            expect(details.select).not.toHaveBeenCalled();
        });

        it("merges accepted crew into the skipper's own list once, with their details, in rank order", () => {
            const profile = rosterSeedsFromVesselProfile({
                crewCount: 3,
                crewRoster: [
                    { name: 'Ana Reyes', age: 51, rank: 'Skipper' },
                    { name: 'Tom', age: 33, rank: 'Crew' },
                    { name: 'Aunt Beryl', age: 71, rank: 'Guest' },
                ],
            });
            const merged = mergeProfileWithCrew(profile, [
                { name: 'Capt. Ana Reyes', role: 'Skipper', source: 'skipper', crewUserId: OWNER },
                {
                    name: 'Thomas Okafor',
                    role: 'Deckhand',
                    source: 'crew',
                    crewUserId: 'u-tom',
                    shared: { name: 'Thomas Okafor', phone: '0491 570 156', age: 34, appName: 'Tom O' },
                },
                { name: 'Lee', role: 'Navigator', source: 'crew', crewUserId: 'u-lee' },
            ]);
            // Lee joined from the crew list last, but a Navigator outranks Crew and Guest.
            expect(merged.map((person) => [person.name, person.role, person.age, person.phone])).toEqual([
                ['Ana Reyes', 'Skipper', 51, null],
                ['Lee', 'Navigator', null, null],
                ['Thomas Okafor', 'Crew', 34, '0491 570 156'],
                ['Aunt Beryl', 'Guest', 71, null],
            ]);
        });

        it('a punter invited first still lists after the First mate (Shane 2026-10-07)', () => {
            const profile = rosterSeedsFromVesselProfile({
                crewRoster: [
                    { name: 'Ana Reyes', age: 51, rank: 'Skipper' },
                    { name: 'Priya Nair', age: 38, rank: 'First mate' },
                ],
            });
            const merged = mergeProfileWithCrew(profile, [
                { name: 'Capt. Ana Reyes', role: 'Skipper', source: 'skipper', crewUserId: OWNER },
                // Invited first, so the crew list (oldest first) has them first.
                { name: 'Pat Example', role: crewRoleToFloatPlanRole('punter'), source: 'crew', crewUserId: 'u-pat' },
                {
                    name: 'Tom Okafor',
                    role: crewRoleToFloatPlanRole('co-skipper'),
                    source: 'crew',
                    crewUserId: 'u-tom',
                },
            ]);
            expect(merged.map((person) => [person.name, person.role])).toEqual([
                ['Ana Reyes', 'Skipper'],
                ['Tom Okafor', 'Co-skipper'],
                ['Priya Nair', 'First mate'],
                ['Pat Example', 'Guest'],
            ]);
        });
    });
});
