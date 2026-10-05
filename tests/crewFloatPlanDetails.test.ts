/**
 * crewFloatPlanDetails — the invitee's app shares their own name, phone and
 * age with their skipper for the float plan (Shane 2026-10-04). Fictional
 * people and numbers only: the repository is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh modules per test (the service remembers the session); the identity
// scope is loaded with them so both see the same one.
let setAuthIdentityScope: (userId: string | null) => void;

const mocks = vi.hoisted(() => ({
    vessels: [] as Array<{ ownerId: string; lastAcceptedAt: string }>,
    result: { error: null as { message: string; code?: string } | null },
    calls: [] as Array<{ op: string; args: unknown[] }>,
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => {
            const record =
                (op: string) =>
                (...args: unknown[]) => {
                    mocks.calls.push({ op: `${table}.${op}`, args });
                    return builder;
                };
            const builder = {
                upsert: record('upsert'),
                delete: record('delete'),
                eq: record('eq'),
                then: (resolve: (value: unknown) => unknown) => Promise.resolve(mocks.result).then(resolve),
            };
            return builder;
        },
    },
}));

vi.mock('../services/vessel/sharedBinders', () => ({
    listCrewVessels: () => mocks.vessels,
}));

const TOM = { name: 'Thomas Okafor', phone: '0491 570 156', age: 34 };

async function load() {
    return import('../services/crew/crewFloatPlanDetails');
}

beforeEach(async () => {
    vi.resetModules();
    ({ setAuthIdentityScope } = await import('../services/authIdentityScope'));
    mocks.vessels = [{ ownerId: 'skipper-1', lastAcceptedAt: '2026-10-01T00:00:00.000Z' }];
    mocks.result = { error: null };
    mocks.calls = [];
    setAuthIdentityScope('crew-1');
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('shareMyFloatPlanDetails', () => {
    it('writes your own row: name, phone and age', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await expect(shareMyFloatPlanDetails(TOM, { from: 'edit' })).resolves.toBe('shared');
        expect(mocks.calls).toEqual([
            {
                op: 'crew_float_plan_details.upsert',
                args: [
                    { user_id: 'crew-1', full_name: 'Thomas Okafor', phone: '0491 570 156', age: 34 },
                    { onConflict: 'user_id' },
                ],
            },
        ]);
    });

    it('writes once per change, and again after a new acceptance', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await shareMyFloatPlanDetails(TOM);
        await expect(shareMyFloatPlanDetails({ ...TOM })).resolves.toBe('unchanged');
        await expect(shareMyFloatPlanDetails({ ...TOM, phone: '0491 570 157' })).resolves.toBe('shared');
        // Leaving removes the row on the server; a re-invite is a new acceptance.
        mocks.vessels = [{ ownerId: 'skipper-1', lastAcceptedAt: '2026-10-04T00:00:00.000Z' }];
        await expect(shareMyFloatPlanDetails({ ...TOM, phone: '0491 570 157' })).resolves.toBe('shared');
        expect(mocks.calls.filter((call) => call.op.endsWith('upsert'))).toHaveLength(3);
    });

    it('removes your row when you clear your details in Settings', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await expect(shareMyFloatPlanDetails({ name: null, phone: null, age: null }, { from: 'edit' })).resolves.toBe(
            'cleared',
        );
        expect(mocks.calls.map((call) => [call.op, ...call.args])).toEqual([
            ['crew_float_plan_details.delete'],
            ['crew_float_plan_details.eq', 'user_id', 'crew-1'],
        ]);
    });

    it('never clears or blanks a shared field just by looking (a device whose Settings have not arrived yet)', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await expect(shareMyFloatPlanDetails({ name: null, phone: null, age: null })).resolves.toBe('empty');
        expect(mocks.calls).toEqual([]);
        // Only what this device has: the phone and age shared from another device stay.
        await expect(shareMyFloatPlanDetails({ name: 'Thomas Okafor', phone: null, age: null })).resolves.toBe(
            'shared',
        );
        expect(mocks.calls).toEqual([
            {
                op: 'crew_float_plan_details.upsert',
                args: [{ user_id: 'crew-1', full_name: 'Thomas Okafor' }, { onConflict: 'user_id' }],
            },
        ]);
    });

    it('an edit sends every field again, even when only looking sent the same details', async () => {
        const { shareMyFloatPlanDetails } = await load();
        const partial = { name: 'Thomas Okafor', phone: null, age: null };
        await shareMyFloatPlanDetails(partial);
        await expect(shareMyFloatPlanDetails(partial, { from: 'edit' })).resolves.toBe('shared');
        expect(mocks.calls.at(-1)?.args[0]).toEqual({
            user_id: 'crew-1',
            full_name: 'Thomas Okafor',
            phone: null,
            age: null,
        });
    });

    it('does nothing for an account that is not crew, or signed out', async () => {
        const { shareMyFloatPlanDetails } = await load();
        mocks.vessels = [];
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('skipped');
        mocks.vessels = [{ ownerId: 'skipper-1', lastAcceptedAt: '2026-10-01T00:00:00.000Z' }];
        setAuthIdentityScope(null);
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('skipped');
        expect(mocks.calls).toEqual([]);
    });

    it('is quiet before the migration is pushed, and stops asking for the session', async () => {
        const { floatPlanDetailsUnavailable, shareMyFloatPlanDetails } = await load();
        mocks.result = {
            error: { message: "Could not find the table 'public.crew_float_plan_details'", code: 'PGRST205' },
        };
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('unavailable');
        expect(floatPlanDetailsUnavailable()).toBe(true);
        await expect(shareMyFloatPlanDetails({ ...TOM, age: 35 })).resolves.toBe('unavailable');
        expect(mocks.calls).toHaveLength(1);
    });

    it('retries after any other failure', async () => {
        const { shareMyFloatPlanDetails } = await load();
        mocks.result = { error: { message: 'offline' } };
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('failed');
        mocks.result = { error: null };
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('shared');
    });
});
