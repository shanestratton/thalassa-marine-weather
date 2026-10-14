/**
 * The vessel profile's people carry a date of birth, and the float plan works
 * their age out on its departure day (129-14, Shane 2026-10-14: "can we change
 * punters age for date of birth. Otherwise we will have to change the age
 * every year").
 *
 * An age typed before 129 keeps showing until someone enters a date of birth;
 * a date of birth is never guessed from it. Fictional people only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { floatPlanSelfDetails, personAge } from '../services/crew/floatPlanPeople';
import { rosterSeedsFromVesselProfile } from '../services/floatPlanCrew';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Noon on 14 October 2026 wherever this runs, so "today" is the 14th.
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
});
afterEach(() => {
    vi.useRealTimers();
});

describe('personAge', () => {
    it('works the age out from the date of birth on the day given', () => {
        expect(personAge({ dateOfBirth: '1979-03-04' }, '2026-10-14')).toBe(47);
        expect(personAge({ dateOfBirth: '1979-10-15' }, '2026-10-14')).toBe(46);
        expect(personAge({ dateOfBirth: '1979-10-15' }, '2026-10-15')).toBe(47);
    });

    it('a date of birth wins over an age typed before it, which goes stale', () => {
        expect(personAge({ dateOfBirth: '1979-03-04', age: 44 }, '2026-10-14')).toBe(47);
    });

    it('keeps an old age when there is no date of birth, and never guesses one from it', () => {
        expect(personAge({ age: 52 }, '2026-10-14')).toBe(52);
        expect(personAge({ age: 52 }, '2031-10-14')).toBe(52);
        expect(personAge({ age: 12.4 }, '2026-10-14')).toBe(12);
    });

    it('has no age for nonsense, a future date, a baby under one, or nothing', () => {
        expect(personAge({ age: -4 }, '2026-10-14')).toBeNull();
        expect(personAge({ age: 130 }, '2026-10-14')).toBeNull();
        expect(personAge({ dateOfBirth: '2027-01-01' }, '2026-10-14')).toBeNull();
        expect(personAge({ dateOfBirth: '2026-06-01' }, '2026-10-14')).toBeNull();
        expect(personAge({ dateOfBirth: '1979-02-30', age: 47 }, '2026-10-14')).toBe(47);
        expect(personAge({}, '2026-10-14')).toBeNull();
        expect(personAge(null, '2026-10-14')).toBeNull();
    });
});

describe('rosterSeedsFromVesselProfile on the departure day', () => {
    const vessel = {
        crewCount: 3,
        crewRoster: [
            { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-10-15' },
            { name: 'Kenji Watanabe', rank: 'First mate', age: 52 },
            { name: 'Amara Okafor', rank: 'Crew' },
        ],
    };

    it("ages the date-of-birth person on the plan's departure day, and keeps the age-only person's age", () => {
        expect(rosterSeedsFromVesselProfile(vessel, '2026-10-14').map((seed) => seed.age)).toEqual([46, 52, null]);
        // Leaving on her birthday: a birthday during the passage does not
        // matter, the departure day does.
        expect(rosterSeedsFromVesselProfile(vessel, '2026-10-15').map((seed) => seed.age)).toEqual([47, 52, null]);
    });

    it('defaults to today, and never carries the date of birth on the seed', () => {
        const seeds = rosterSeedsFromVesselProfile(vessel);
        expect(seeds[0]).toEqual({ name: 'Ingrid Solberg', role: 'Skipper', source: 'profile', age: 46 });
        expect(JSON.stringify(seeds)).not.toContain('1979');
    });
});

describe('floatPlanSelfDetails: an invitee shares their date of birth with their skipper', () => {
    it('shares the date of birth and the age it gives today', () => {
        expect(
            floatPlanSelfDetails({
                contactPhone: '0400 000 001',
                crewRoster: [{ name: 'Thomas Okafor', dateOfBirth: '1992-02-29', rank: 'Skipper' }],
            }),
        ).toEqual({ name: 'Thomas Okafor', phone: '0400 000 001', age: 34, dateOfBirth: '1992-02-29' });
    });

    it('an age-only row shares its age and no date of birth', () => {
        expect(floatPlanSelfDetails({ crewRoster: [{ name: 'Thomas Okafor', age: 34 }] })).toEqual({
            name: 'Thomas Okafor',
            phone: null,
            age: 34,
        });
    });

    it('never shares a date that is not a birth date', () => {
        for (const dateOfBirth of ['2030-01-01', '1979-02-30', 'soon']) {
            expect(floatPlanSelfDetails({ crewRoster: [{ name: 'Thomas Okafor', dateOfBirth }] })).toEqual({
                name: 'Thomas Okafor',
                phone: null,
                age: null,
            });
        }
    });
});
