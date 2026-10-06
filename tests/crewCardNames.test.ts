/**
 * crewCardNames — the names on the skipper's crew cards (Crew & Float Plan,
 * 2026-10-06): their own float-plan name first, else their byline on the
 * boat; only the NAME is ever read; remembered per account so the cards paint
 * at once; a failed read keeps what was known. Fictional people only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const supabaseMocks = vi.hoisted(() => ({ from: vi.fn() }));
const boatMocks = vi.hoisted(() => ({ activeOwnedBoatId: vi.fn() }));

vi.mock('../services/supabase', () => ({ supabase: { from: supabaseMocks.from } }));
vi.mock('../components/crewManagement/activeOwnedBoat', () => ({
    activeOwnedBoatId: boatMocks.activeOwnedBoatId,
}));

import { loadCrewCardNames, readCrewCardNames } from '../services/crew/crewCardNames';

type Result = { data: unknown; error: { message: string; code?: string } | null };

/** A thenable query builder that records its calls. */
function queryBuilder(result: Result) {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> & { calls: typeof calls } = { calls };
    for (const method of ['select', 'eq', 'in']) {
        builder[method] = (...args: unknown[]) => {
            calls.push([method, args]);
            return builder;
        };
    }
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return builder;
}

function tables(shared: Result, bylines: Result) {
    const built: Record<string, ReturnType<typeof queryBuilder>> = {};
    supabaseMocks.from.mockImplementation((table: string) => {
        built[table] = queryBuilder(table === 'crew_float_plan_details' ? shared : bylines);
        return built[table];
    });
    return built;
}

const KEY = 'thalassa_crew_card_names_v1';

describe('crewCardNames', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-1');
        boatMocks.activeOwnedBoatId.mockResolvedValue('boat-1');
    });

    it("prefers the crew member's own float-plan name, then their byline, and reads only names", async () => {
        const built = tables(
            { data: [{ user_id: 'u-mia', full_name: '  Mia   Chen ' }], error: null },
            {
                data: [
                    { user_id: 'u-mia', prefix: null, first_name: 'Mia', last_name: null, nickname: null },
                    { user_id: 'u-lee', prefix: null, first_name: 'Lena', last_name: 'Park', nickname: 'Lee' },
                ],
                error: null,
            },
        );
        const names = await loadCrewCardNames(getAuthIdentityScope(), ['u-mia', 'u-lee', 'u-mia']);
        expect(names).toEqual({ 'u-mia': 'Mia Chen', 'u-lee': 'Lena "Lee" Park' });

        // Privacy: never a phone or an age from the shared table.
        const sharedSelect = built.crew_float_plan_details.calls.find(([method]) => method === 'select');
        expect(sharedSelect?.[1]).toEqual(['user_id, full_name']);
        expect(JSON.stringify(built.crew_float_plan_details.calls)).not.toMatch(/phone|age/);
        // One query each, for every id at once, on the skipper's selected boat.
        expect(built.boat_members.calls).toContainEqual(['eq', ['boat_id', 'boat-1']]);
        expect(built.boat_members.calls).toContainEqual(['in', ['user_id', ['u-mia', 'u-lee']]]);

        // Remembered for the next paint, for this account only.
        expect(readCrewCardNames(getAuthIdentityScope())).toEqual(names);
        setAuthIdentityScope('someone-else');
        expect(readCrewCardNames(getAuthIdentityScope())).toEqual({});
    });

    it('answers from the bylines before the shared table is pushed', async () => {
        tables(
            { data: null, error: { message: 'relation does not exist', code: '42P01' } },
            { data: [{ user_id: 'u-mia', first_name: 'Mia', last_name: 'Chen' }], error: null },
        );
        expect(await loadCrewCardNames(getAuthIdentityScope(), ['u-mia'])).toEqual({ 'u-mia': 'Mia Chen' });
    });

    it('keeps what it knew when the reads fail, and is null with no answer at all', async () => {
        const scope = getAuthIdentityScope();
        localStorage.setItem(
            authScopedStorageKey(KEY, scope),
            JSON.stringify({ version: 1, userId: 'skipper-1', names: { 'u-mia': 'Mia Chen' } }),
        );
        tables({ data: null, error: { message: 'offline' } }, { data: null, error: { message: 'offline' } });
        expect(await loadCrewCardNames(scope, ['u-mia'])).toBeNull();
        expect(readCrewCardNames(scope)).toEqual({ 'u-mia': 'Mia Chen' });

        // One read failing keeps the known name for what it would have said.
        tables({ data: [], error: null }, { data: null, error: { message: 'offline' } });
        expect(await loadCrewCardNames(scope, ['u-mia'])).toEqual({ 'u-mia': 'Mia Chen' });
    });

    it('with no accepted crew there is nothing to read and nothing kept', async () => {
        const scope = getAuthIdentityScope();
        localStorage.setItem(
            authScopedStorageKey(KEY, scope),
            JSON.stringify({ version: 1, userId: 'skipper-1', names: { 'u-old': 'Old Crew' } }),
        );
        expect(await loadCrewCardNames(scope, [])).toEqual({});
        expect(supabaseMocks.from).not.toHaveBeenCalled();
        expect(readCrewCardNames(scope)).toEqual({});
    });

    it('drops an answer that lands after the account changed', async () => {
        const scope = getAuthIdentityScope();
        boatMocks.activeOwnedBoatId.mockImplementation(async () => {
            setAuthIdentityScope('someone-else');
            return 'boat-1';
        });
        tables({ data: [{ user_id: 'u-mia', full_name: 'Mia Chen' }], error: null }, { data: [], error: null });
        expect(await loadCrewCardNames(scope, ['u-mia'])).toBeNull();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('ignores malformed or foreign records', () => {
        const scope = getAuthIdentityScope();
        const key = authScopedStorageKey(KEY, scope);
        localStorage.setItem(key, '{oops');
        expect(readCrewCardNames(scope)).toEqual({});
        localStorage.setItem(key, JSON.stringify({ version: 1, userId: 'someone-else', names: { u: 'X' } }));
        expect(readCrewCardNames(scope)).toEqual({});
        localStorage.setItem(key, JSON.stringify({ version: 1, userId: 'skipper-1', names: { u: 42, v: ' ' } }));
        expect(readCrewCardNames(scope)).toEqual({});
    });
});
