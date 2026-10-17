/**
 * The Crew & Float Plan card's count (129-14, Shane 2026-10-14: "the crew and
 * float plan card says two crew. But there is actually three. 2+1 invitee").
 *
 * The card counted the larger of the profile's "Crew aboard" and the app crew
 * plus the skipper, so a boat with two people on its profile and one accepted
 * invitee read "2 crew". It now counts everyone on the crew register once, by
 * the float plan's own identity rule (mergeAboard): the profile's people, the
 * skipper and accepted crew, then pending invitees, and says how many are
 * still invited. Fictional people only: the repository is public.
 */
import { describe, expect, it } from 'vitest';
import { crewRegisterCount } from '../services/crew/floatPlanPeople';
import type { FloatPlanRosterSeed } from '../services/floatPlanCrew';

const skipper = (name = 'Ingrid Solberg'): FloatPlanRosterSeed => ({
    name,
    role: 'Skipper',
    source: 'skipper',
    crewUserId: 'owner-1',
});
const accepted = (name: string, id: string, own?: string): FloatPlanRosterSeed => ({
    name: own ?? name,
    role: 'Co-skipper',
    source: 'crew',
    crewUserId: id,
    ...(own ? { shared: { name: own, phone: null, age: null, appName: name } } : {}),
});
const invited = (name: string, id: string): FloatPlanRosterSeed => ({
    name,
    role: 'Guest',
    source: 'invite',
    crewUserId: id,
});

const TWO_ON_PROFILE = {
    crewCount: 2,
    crewRoster: [
        { name: 'Ingrid Solberg', rank: 'Skipper' },
        { name: 'Kenji Watanabe', rank: 'First mate' },
    ],
};

describe('crewRegisterCount', () => {
    it("Shane's boat: two on the profile and one accepted invitee are three, not two", () => {
        expect(
            crewRegisterCount(TWO_ON_PROFILE, {
                aboard: [skipper('Capt. Ingrid Solberg'), accepted('Amara Okafor', 'u-amara')],
                invited: [],
            }),
        ).toEqual({ crew: 3, invited: 0 });
    });

    it('two accepted and one still invited read three, one of them invited', () => {
        expect(
            crewRegisterCount(
                { crewCount: 2 },
                {
                    aboard: [skipper(), accepted('Amara Okafor', 'u-amara')],
                    invited: [invited('Lucas Moreau', 'u-lucas')],
                },
            ),
        ).toEqual({ crew: 3, invited: 1 });
    });

    it('counts a person on the profile who is also accepted crew once, by the float plan rule', () => {
        // The skipper typed "Kenji Watanabe"; Kenji accepted, and his own
        // Settings call him "Kenji Watanabe" too, the app "Kenji W".
        expect(
            crewRegisterCount(TWO_ON_PROFILE, {
                aboard: [skipper(), accepted('Kenji W', 'u-kenji', 'Kenji Watanabe')],
                invited: [],
            }),
        ).toEqual({ crew: 2, invited: 0 });
        // Accents and scripts beyond Latin: "José Núñez" is "Jose Nunez", and
        // "渡辺 健二" typed on the profile is the same 渡辺 健二 who accepted.
        expect(
            crewRegisterCount(
                {
                    crewCount: 3,
                    crewRoster: [
                        { name: 'Ingrid Solberg', rank: 'Skipper' },
                        { name: 'Jose Nunez', rank: 'Crew' },
                        { name: '渡辺 健二', rank: 'Crew' },
                    ],
                },
                {
                    aboard: [skipper(), accepted('José Núñez', 'u-jose'), accepted('渡辺 健二', 'u-kenji')],
                    invited: [invited('Lucas Moreau', 'u-lucas')],
                },
            ),
        ).toEqual({ crew: 4, invited: 1 });
    });

    it('an invitee the skipper already put on the profile is one person, still counted as invited', () => {
        expect(
            crewRegisterCount(TWO_ON_PROFILE, { aboard: [skipper()], invited: [invited('Kenji Watanabe', 'u-kenji')] }),
        ).toEqual({ crew: 2, invited: 1 });
    });

    // A known limit, pinned (129-14 review): until someone accepts, the app
    // names them from their invite's email (renderCrewDisplayName), so an
    // invitee is matched to the profile row the skipper typed only when the
    // email reads as their whole name or as a first name no one else aboard
    // shares. Otherwise they are counted beside that row until they accept.
    // Counting them is the point (Shane's "2+1 invitee" was a pending invite
    // named from an email), and a count one high corrects itself on acceptance.
    it('matches a pending invitee named from an email only when the email reads as their name', () => {
        const THREE_ON_PROFILE = {
            crewCount: 3,
            crewRoster: [
                { name: 'Ingrid Solberg', rank: 'Skipper' },
                { name: 'Kenji Watanabe', rank: 'First mate' },
                { name: 'Amara Okafor', rank: 'Crew' },
            ],
        };
        const count = (emailName: string) =>
            crewRegisterCount(THREE_ON_PROFILE, { aboard: [skipper()], invited: [invited(emailName, 'u-amara')] });
        // amara.okafor@example.com, and amara@example.com: Amara, once.
        expect(count('Amara Okafor')).toEqual({ crew: 3, invited: 1 });
        expect(count('Amara')).toEqual({ crew: 3, invited: 1 });
        // aokafor@example.com reads as "Aokafor": listed beside her row until she accepts.
        expect(count('Aokafor')).toEqual({ crew: 4, invited: 1 });
        // Once she accepts, her own name matches her row: three again.
        expect(
            crewRegisterCount(THREE_ON_PROFILE, {
                aboard: [skipper(), accepted('Aokafor', 'u-amara', 'Amara Okafor')],
                invited: [],
            }),
        ).toEqual({ crew: 3, invited: 0 });
    });

    it('never counts fewer than the profile\'s "Crew aboard"', () => {
        expect(crewRegisterCount({ crewCount: 5 }, { aboard: [skipper()], invited: [] })).toEqual({
            crew: 5,
            invited: 0,
        });
        // Signed out, or before the crew list answers: the profile alone.
        expect(crewRegisterCount(TWO_ON_PROFILE, null)).toEqual({ crew: 2, invited: 0 });
        expect(crewRegisterCount({ crewCount: 4 }, null)).toEqual({ crew: 4, invited: 0 });
    });

    it('says nothing when nothing real is known: no profile people, no count set, no crew', () => {
        // "2 crew" on a fresh install read as a count (UX scorecard run 6),
        // and the skipper alone is never counted as a default.
        expect(crewRegisterCount({}, null)).toBeNull();
        expect(crewRegisterCount(null, null)).toBeNull();
        expect(crewRegisterCount({}, { aboard: [skipper('')], invited: [] })).toBeNull();
        // One accepted crew member with nothing else set: the two of them.
        expect(
            crewRegisterCount({}, { aboard: [skipper(''), accepted('Amara Okafor', 'u-amara')], invited: [] }),
        ).toEqual({ crew: 2, invited: 0 });
    });
});
