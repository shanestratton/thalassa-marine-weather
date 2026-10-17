/**
 * The skipper's float plan reads an invitee's date of birth and prints the
 * age it gives on the departure day (129-14). The date of birth stops at the
 * loader: the roster seeds the sheet builds the plan from carry the age only.
 * Before the 129 migration the column is missing and the read falls back to
 * age. The Vessel hub's count reads names only. Fictional people only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const supabaseMocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn() }));
const boatMocks = vi.hoisted(() => ({ activeOwnedBoatId: vi.fn() }));

vi.mock('../services/supabase', () => ({
    supabase: { auth: { getUser: supabaseMocks.getUser }, from: supabaseMocks.from },
}));
vi.mock('../components/crewManagement/activeOwnedBoat', () => ({
    activeOwnedBoatId: boatMocks.activeOwnedBoatId,
}));

const OWNER = 'owner-1';

type Result = { data: unknown; error: { message: string; code?: string } | null };

/** A thenable query builder that answers each await from `results` in turn (the last one repeats). */
function queryBuilder(results: Result[]) {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'neq', 'limit']) {
        builder[method] = (...args: unknown[]) => {
            calls.push([method, args]);
            return builder;
        };
    }
    let answered = 0;
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(results[Math.min(answered++, results.length - 1)]).then(resolve, reject);
    return { builder, calls, selects: () => calls.filter(([m]) => m === 'select').map(([, args]) => args[0]) };
}

function tables(config: { crew: Result; details: Result[]; members?: Result }) {
    const crew = queryBuilder([config.crew]);
    const members = queryBuilder([config.members ?? { data: [], error: null }]);
    const details = queryBuilder(config.details);
    const voyages = queryBuilder([{ data: [], error: null }]);
    supabaseMocks.from.mockImplementation((table: string) => {
        if (table === 'vessel_crew') return crew.builder;
        if (table === 'boat_members') return members.builder;
        if (table === 'crew_float_plan_details') return details.builder;
        if (table === 'voyages') return voyages.builder;
        throw new Error(`unexpected table ${table}`);
    });
    return { crew, members, details, voyages };
}

const ACCEPTED = [
    {
        id: 'c-1',
        crew_user_id: 'u-tom',
        crew_email: 'tom@example.com',
        status: 'accepted',
        role: 'deckhand',
        voyage_id: null,
    },
    {
        id: 'c-2',
        crew_user_id: 'u-lin',
        crew_email: 'lin@example.com',
        status: 'accepted',
        role: 'navigator',
        voyage_id: null,
    },
];
const DETAILS = [
    { user_id: 'u-tom', full_name: 'Thomas Okafor', phone: '0400 000 002', age: 33, date_of_birth: '1992-10-15' },
    { user_id: 'u-lin', full_name: 'Lin Wei', phone: null, age: 41, date_of_birth: null },
];

async function loader() {
    return (await import('../services/floatPlanCrew')).loadFloatPlanCrew;
}

beforeEach(() => {
    vi.resetModules();
    supabaseMocks.getUser.mockReset();
    supabaseMocks.from.mockReset();
    setAuthIdentityScope(OWNER);
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: OWNER, user_metadata: {} } }, error: null });
    boatMocks.activeOwnedBoatId.mockResolvedValue('boat-1');
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('loadFloatPlanCrew and an invitee date of birth', () => {
    it('prints the age the date of birth gives on the departure day, and an old age where there is none', async () => {
        const { details } = tables({
            crew: { data: ACCEPTED, error: null },
            details: [{ data: DETAILS, error: null }],
        });
        const load = await loader();
        // The day before Thomas's birthday, then the day itself.
        const before = await load(null, { onDay: '2026-10-14' });
        expect(before!.aboard.map((seed) => seed.shared?.age ?? null)).toEqual([null, 33, 41]);
        const birthday = await load(null, { onDay: '2026-10-15' });
        expect(birthday!.aboard.map((seed) => seed.shared?.age ?? null)).toEqual([null, 34, 41]);
        expect(details.selects()[0]).toBe('user_id, full_name, phone, age, date_of_birth');
    });

    it('the date of birth never leaves the loader: the seeds carry the age only', async () => {
        tables({ crew: { data: ACCEPTED, error: null }, details: [{ data: DETAILS, error: null }] });
        const result = await (await loader())(null, { onDay: '2026-10-14' });
        expect(result!.aboard[1].shared).toEqual({
            name: 'Thomas Okafor',
            phone: '0400 000 002',
            age: 33,
            appName: 'Tom',
        });
        expect(JSON.stringify(result)).not.toContain('1992');
    });

    it('before the 129 migration: asks again without the column, then remembers', async () => {
        const missing: Result = {
            data: null,
            error: { code: '42703', message: 'column crew_float_plan_details.date_of_birth does not exist' },
        };
        const { details } = tables({
            crew: { data: ACCEPTED, error: null },
            details: [missing, { data: DETAILS.map(({ date_of_birth: _dob, ...row }) => row), error: null }],
        });
        const load = await loader();
        const result = await load(null, { onDay: '2026-10-14' });
        expect(result!.aboard.map((seed) => seed.shared?.age ?? null)).toEqual([null, 33, 41]);
        await load(null, { onDay: '2026-10-14' });
        expect(details.selects()).toEqual([
            'user_id, full_name, phone, age, date_of_birth',
            'user_id, full_name, phone, age',
            'user_id, full_name, phone, age',
        ]);
    });

    it("the Vessel hub's count reads names only, every passage's pending invites, and no passage names", async () => {
        const { details, voyages } = tables({
            crew: {
                data: [
                    { ...ACCEPTED[0], voyage_id: 'v-old' },
                    {
                        id: 'c-3',
                        crew_user_id: 'u-ana',
                        crew_email: 'ana@example.com',
                        status: 'pending',
                        role: 'punter',
                        voyage_id: 'v-next',
                    },
                    {
                        id: 'c-4',
                        crew_user_id: null,
                        crew_email: 'lucas.m@example.com',
                        status: 'pending',
                        role: 'deckhand',
                        voyage_id: null,
                    },
                ],
                error: null,
            },
            details: [{ data: [{ user_id: 'u-tom', full_name: 'Thomas Okafor' }], error: null }],
        });
        const result = await (await loader())(null, { forCount: true });
        expect(details.selects()).toEqual(['user_id, full_name']);
        expect(voyages.calls).toEqual([]);
        expect(result!.aboard.map((seed) => seed.name)).toEqual(['', 'Thomas Okafor']);
        expect(result!.aboard[1].shared).toEqual({ name: 'Thomas Okafor', phone: null, age: null, appName: 'Tom' });
        // A passage-scoped invite is still someone invited to the boat.
        expect(result!.invited.map((seed) => seed.name)).toEqual(['Ana', 'Lucas M']);
    });
});
