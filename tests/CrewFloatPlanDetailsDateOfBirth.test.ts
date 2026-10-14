/**
 * An invitee shares their date of birth with their skipper, not just an age
 * (129-14, Shane 2026-10-14: "can we change punters age for date of birth").
 *
 * The write merges, and never blanks a field the writer did not send: a 128
 * phone writes an age only, and that must not wipe a date of birth a 129
 * phone stored. Before the 129 migration is pushed the column is missing, and
 * the share falls back to the age-only row it wrote before. Fictional people
 * and dates only: the repository is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let setAuthIdentityScope: (userId: string | null) => void;

const mocks = vi.hoisted(() => ({
    vessels: [] as Array<{ ownerId: string; lastAcceptedAt: string }>,
    results: [] as Array<{ error: { message: string; code?: string } | null }>,
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
                then: (resolve: (value: unknown) => unknown) =>
                    Promise.resolve(mocks.results.shift() ?? { error: null }).then(resolve),
            };
            return builder;
        },
    },
}));

vi.mock('../services/vessel/sharedBinders', () => ({
    listCrewVessels: () => mocks.vessels,
}));

const TOM = { name: 'Thomas Okafor', phone: '0400 000 002', age: 34, dateOfBirth: '1992-02-29' };
const upserts = () => mocks.calls.filter((call) => call.op.endsWith('upsert')).map((call) => call.args[0]);

async function load() {
    return import('../services/crew/crewFloatPlanDetails');
}

beforeEach(async () => {
    vi.resetModules();
    ({ setAuthIdentityScope } = await import('../services/authIdentityScope'));
    mocks.vessels = [{ ownerId: 'skipper-1', lastAcceptedAt: '2026-10-01T00:00:00.000Z' }];
    mocks.results = [];
    mocks.calls = [];
    setAuthIdentityScope('crew-1');
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('shareMyFloatPlanDetails with a date of birth', () => {
    it('an edit writes the date of birth with the age it gives, for skippers still on 128', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await expect(shareMyFloatPlanDetails(TOM, { from: 'edit' })).resolves.toBe('shared');
        expect(upserts()).toEqual([
            {
                user_id: 'crew-1',
                full_name: 'Thomas Okafor',
                phone: '0400 000 002',
                age: 34,
                date_of_birth: '1992-02-29',
            },
        ]);
    });

    it('a look writes the date of birth this device has', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await shareMyFloatPlanDetails({ name: 'Thomas Okafor', phone: null, age: 34, dateOfBirth: '1992-02-29' });
        expect(upserts()).toEqual([
            { user_id: 'crew-1', full_name: 'Thomas Okafor', age: 34, date_of_birth: '1992-02-29' },
        ]);
    });

    it('an age-only write, as a 128 phone sends, never names the date of birth, so a stored one stays', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await shareMyFloatPlanDetails({ name: 'Thomas Okafor', phone: null, age: 34 }, { from: 'edit' });
        await shareMyFloatPlanDetails({ name: 'Thomas Okafor', phone: '0400 000 003', age: 35 });
        for (const row of upserts()) expect(row).not.toHaveProperty('date_of_birth');
    });

    it('clears the date of birth only when this device cleared it', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await shareMyFloatPlanDetails(
            { name: 'Thomas Okafor', phone: null, age: null },
            { from: 'edit', clearDateOfBirth: true },
        );
        expect(upserts()).toEqual([
            { user_id: 'crew-1', full_name: 'Thomas Okafor', phone: null, age: null, date_of_birth: null },
        ]);
    });

    it('a date of birth alone is something to share, and clearing everything removes the row', async () => {
        const { shareMyFloatPlanDetails } = await load();
        await expect(
            shareMyFloatPlanDetails({ name: null, phone: null, age: null, dateOfBirth: '2026-06-01' }),
        ).resolves.toBe('shared');
        await expect(
            shareMyFloatPlanDetails({ name: null, phone: null, age: null }, { from: 'edit', clearDateOfBirth: true }),
        ).resolves.toBe('cleared');
        expect(mocks.calls.at(-2)?.op).toBe('crew_float_plan_details.delete');
    });

    it('before the 129 migration: writes the age-only row instead, and stops naming the column', async () => {
        const { shareMyFloatPlanDetails } = await load();
        mocks.results = [
            {
                error: {
                    code: 'PGRST204',
                    message:
                        "Could not find the 'date_of_birth' column of 'crew_float_plan_details' in the schema cache",
                },
            },
        ];
        await expect(shareMyFloatPlanDetails(TOM, { from: 'edit' })).resolves.toBe('shared');
        expect(upserts()).toEqual([
            {
                user_id: 'crew-1',
                full_name: 'Thomas Okafor',
                phone: '0400 000 002',
                age: 34,
                date_of_birth: '1992-02-29',
            },
            { user_id: 'crew-1', full_name: 'Thomas Okafor', phone: '0400 000 002', age: 34 },
        ]);
        // The session remembers: the next share does not try the column first.
        await shareMyFloatPlanDetails({ ...TOM, phone: '0400 000 004' }, { from: 'edit' });
        expect(upserts().at(-1)).toEqual({
            user_id: 'crew-1',
            full_name: 'Thomas Okafor',
            phone: '0400 000 004',
            age: 34,
        });
        expect(upserts()).toHaveLength(3);
    });

    it('a Postgres "no such column" is the same answer', async () => {
        const { shareMyFloatPlanDetails } = await load();
        mocks.results = [
            {
                error: {
                    code: '42703',
                    message: 'column "date_of_birth" of relation "crew_float_plan_details" does not exist',
                },
            },
        ];
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('shared');
        expect(upserts().at(-1)).not.toHaveProperty('date_of_birth');
    });

    it('a missing column it was not asked about is still a failure', async () => {
        const { shareMyFloatPlanDetails } = await load();
        mocks.results = [{ error: { code: '42703', message: 'column "phone" does not exist' } }];
        await expect(shareMyFloatPlanDetails(TOM)).resolves.toBe('failed');
        expect(upserts()).toHaveLength(1);
    });
});
