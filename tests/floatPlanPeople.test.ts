/**
 * floatPlanPeople — everyone aboard, each person once (Shane 2026-10-04: "the
 * invitee needs to use the name and phone number and age from the vessel
 * profile in settings for the float plan, also the number of pob's needs to
 * include the invitee as well as the others on board").
 *
 * Fictional people and numbers only: the repository is public.
 */
import { describe, expect, it } from 'vitest';
import { aboardCount, floatPlanSelfDetails, isNotPushedYet, mergeAboard } from '../services/crew/floatPlanPeople';

const SKIPPER_ROW = { name: 'Ana Reyes', role: 'Skipper', age: 51 };
const GUEST_ROW = { name: 'Sam Example', role: 'Guest', age: 30 };

describe('floatPlanSelfDetails', () => {
    it('reads your own name and age from the first Crew row and your phone from Skipper mobile', () => {
        expect(
            floatPlanSelfDetails({
                contactPhone: ' 0491 570 156 ',
                crewRoster: [
                    { name: '  Tom   Okafor ', age: 34 },
                    { name: 'Someone Else', age: 70 },
                ],
            }),
        ).toEqual({ name: 'Tom Okafor', phone: '0491 570 156', age: 34 });
    });

    it('takes the row ranked Skipper when it is not the first, so a partner listed first is not sent as you', () => {
        expect(
            floatPlanSelfDetails({
                contactPhone: '0491 570 156',
                crewRoster: [
                    { name: 'Ana Reyes', age: 40, rank: 'First mate' },
                    { name: 'Tom Okafor', age: 34, rank: 'skipper' },
                ],
            }),
        ).toEqual({ name: 'Tom Okafor', phone: '0491 570 156', age: 34 });
    });

    it('is null where nothing usable is set', () => {
        expect(floatPlanSelfDetails(null)).toEqual({ name: null, phone: null, age: null });
        expect(floatPlanSelfDetails({ contactPhone: '  ', crewRoster: [{ name: '', age: 0 }] })).toEqual({
            name: null,
            phone: null,
            age: null,
        });
        expect(floatPlanSelfDetails({ crewRoster: [{ name: 'Tom', age: 130 }] }).age).toBeNull();
    });
});

describe('mergeAboard', () => {
    it("adds an accepted invitee who is not on the skipper's own list, with their own phone and age", () => {
        const people = mergeAboard(
            [SKIPPER_ROW, GUEST_ROW],
            [
                { appName: 'Capt Ana Reyes', role: 'Skipper', isSkipper: true, crewUserId: 'skipper-1' },
                {
                    appName: 'Tom O',
                    ownName: 'Tom Okafor',
                    role: 'Deckhand',
                    crewUserId: 'crew-1',
                    phone: '0491 570 156',
                    age: 34,
                },
            ],
        );
        expect(people.map((person) => [person.name, person.role, person.age, person.phone])).toEqual([
            ['Ana Reyes', 'Skipper', 51, null],
            ['Sam Example', 'Guest', 30, null],
            ['Tom Okafor', 'Deckhand', 34, '0491 570 156'],
        ]);
    });

    it('counts a person on both lists once, however the skipper typed them, and their own details win', () => {
        const people = mergeAboard(
            [SKIPPER_ROW, { name: 'Tom', role: 'Crew', age: 33 }, { name: 'Lena Park', role: 'Navigator' }],
            [
                { appName: '', role: 'Skipper', isSkipper: true },
                { appName: 'Tom O', ownName: 'Tom Okafor', role: 'Deckhand', phone: '0491 570 156', age: null },
                { appName: 'Lena "Lee" Park', role: 'Navigator', crewUserId: 'crew-2' },
            ],
        );
        expect(people).toEqual([
            { name: 'Ana Reyes', role: 'Skipper', age: 51, phone: null, crewUserId: null, isSelf: false, added: false },
            // A lone first name merges when it can only be one person; the skipper's
            // rank stays, the invitee's own name and phone win, his typed age stands in.
            {
                name: 'Tom Okafor',
                role: 'Crew',
                age: 33,
                phone: '0491 570 156',
                crewUserId: null,
                isSelf: false,
                added: false,
            },
            // A quoted nickname and a middle name do not make a second person.
            {
                name: 'Lena Park',
                role: 'Navigator',
                age: null,
                phone: null,
                crewUserId: 'crew-2',
                isSelf: false,
                added: false,
            },
        ]);
    });

    it('counts one person once across a curly apostrophe, a hyphen or an accent', () => {
        // iOS types a curly apostrophe; the skipper may type a plain one.
        const pairs: Array<[string, string]> = [
            ['Tom O’Brien', "Tom O'Brien"],
            ['Anne Marie Lee', 'Anne-Marie Lee'],
            ['Zoe Park', 'Zoë Park'],
            ['Zoe Park', 'Zoë Park'],
        ];
        for (const [typed, own] of pairs) {
            const people = mergeAboard(
                [SKIPPER_ROW, { name: typed, role: 'Crew' }],
                [{ appName: 'x', ownName: own, role: 'Deckhand', crewUserId: 'crew-1' }],
            );
            expect(people.map((person) => person.name)).toEqual(['Ana Reyes', own]);
        }
    });

    it("marks who joined from the app crew, not from the skipper's own list", () => {
        const people = mergeAboard(
            [SKIPPER_ROW, GUEST_ROW],
            [
                { appName: 'Ana Reyes', role: 'Skipper', isSkipper: true },
                { appName: 'Marta Diaz', role: 'Deckhand', crewUserId: 'crew-1' },
            ],
        );
        expect(people.map((person) => [person.name, person.added])).toEqual([
            ['Ana Reyes', false],
            ['Sam Example', false],
            ['Marta Diaz', true],
        ]);
    });

    it('matches through titles and middle names, but never two different people', () => {
        const people = mergeAboard(
            [
                { name: 'Dr. Mia Jo Tan', role: 'Crew' },
                { name: 'Mia Lim', role: 'Crew' },
            ],
            [
                { appName: 'Mia Tan', role: 'Deckhand' },
                { appName: 'Mia Lim', role: 'Punter' },
                { appName: 'Mia Chen', role: 'Punter' },
            ],
        );
        expect(people.map((person) => person.name)).toEqual(['Dr. Mia Jo Tan', 'Mia Lim', 'Mia Chen']);
    });

    it('lists both when a lone first name could be either of two people', () => {
        const people = mergeAboard(
            [SKIPPER_ROW, { name: 'Tom', role: 'Crew' }],
            [
                { appName: 'Tom Okafor', role: 'Deckhand' },
                { appName: 'Tom Lee', role: 'Punter' },
            ],
        );
        expect(people.map((person) => person.name)).toEqual(['Ana Reyes', 'Tom', 'Tom Okafor', 'Tom Lee']);
    });

    it('puts an app skipper missing from the list first, and marks your own row', () => {
        const people = mergeAboard(
            [{ name: 'Sam Example', role: 'Guest' }],
            [
                { appName: 'Ana Reyes', role: 'Skipper', isSkipper: true },
                { appName: 'Tom Okafor', role: 'Deckhand', isSelf: true, phone: '0491 570 156', age: 34 },
            ],
        );
        expect(people.map((person) => [person.name, person.isSelf])).toEqual([
            ['Ana Reyes', false],
            ['Sam Example', false],
            ['Tom Okafor', true],
        ]);
    });

    it('is the app crew alone when the skipper has no named profile rows', () => {
        expect(
            mergeAboard(
                [],
                [
                    { appName: 'Ana Reyes', role: 'Skipper', isSkipper: true },
                    { appName: 'Tom Okafor', role: 'Deckhand' },
                ],
            ).map((person) => person.name),
        ).toEqual(['Ana Reyes', 'Tom Okafor']);
    });
});

describe('aboardCount', () => {
    it("is everyone listed, never fewer than the skipper's own Crew aboard count, 1 to 99", () => {
        expect(aboardCount(3, 2)).toBe(3);
        expect(aboardCount(3, 4)).toBe(4);
        expect(aboardCount(3, undefined)).toBe(3);
        expect(aboardCount(0, null)).toBe(1);
        expect(aboardCount(120, 2)).toBe(99);
    });
});

describe('isNotPushedYet', () => {
    it("is PostgREST's and Postgres's 'no such table or function', and nothing else", () => {
        for (const code of ['PGRST205', '42P01', 'PGRST202', '42883']) {
            expect(isNotPushedYet({ code, message: 'missing' })).toBe(true);
        }
        for (const error of [{ code: '42501' }, { code: 'PGRST301' }, { message: 'offline' }, null, undefined, 'x']) {
            expect(isNotPushedYet(error)).toBe(false);
        }
    });
});
