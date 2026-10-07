/**
 * crewRank — the one order people aboard are listed in (Shane 2026-10-07: "in
 * the float plan ... can we order the punters on board by their rank?").
 *
 * Skipper → Co-skipper → First mate → Navigator → Engineer / Bosun / Watch
 * captain → Cook / Radio operator → Deckhand / Crew (and anything unknown) →
 * Punter / Guest / Passenger; ties by name, then the order they arrived in.
 *
 * Fictional people only: the repository is public.
 */
import { describe, expect, it } from 'vitest';
import {
    CREW_RANK_TIERS,
    crewRankOrder,
    crewRankTier,
    sortByCrewRank,
    type CrewRankTier,
} from '../services/crew/crewRank';
import { CREW_ROLE_SENIORITY } from '../services/crew/floatPlanPeople';
import { crewRoleLabel } from '../services/crew/crewVesselView';
import { FLOAT_PLAN_ROLES, crewRoleToFloatPlanRole } from '../services/floatPlanCrew';
import { INVITE_ROLE_OPTIONS } from '../components/crew/InviteCrewModal';

function expectTier(tier: CrewRankTier, ranks: string[]) {
    for (const rank of ranks) expect([rank, crewRankTier(rank)]).toEqual([rank, tier]);
}

describe('crewRankTier — every rank the app writes', () => {
    it('reads each Float Plan role (the sheet and Vessel profile picker) at its rank', () => {
        const expected: Record<(typeof FLOAT_PLAN_ROLES)[number], CrewRankTier> = {
            Skipper: 'skipper',
            'Co-skipper': 'co-skipper',
            'First mate': 'first-mate',
            Navigator: 'navigator',
            Engineer: 'officer',
            Cook: 'specialist',
            Deckhand: 'crew',
            Crew: 'crew',
            Guest: 'guest',
            Child: 'guest',
        };
        for (const role of FLOAT_PLAN_ROLES) expect([role, crewRankTier(role)]).toEqual([role, expected[role]]);
    });

    it('the Float Plan role picker already lists its roles in rank order', () => {
        const orders = FLOAT_PLAN_ROLES.map((role) => crewRankOrder(role));
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    it('reads each invite role, raw and as every screen labels it, at the same rank', () => {
        const expected: Record<string, CrewRankTier> = {
            'co-skipper': 'co-skipper',
            navigator: 'navigator',
            deckhand: 'crew',
            punter: 'guest',
        };
        for (const [role, tier] of Object.entries(expected)) {
            expect([role, crewRankTier(role)]).toEqual([role, tier]);
            expect([role, crewRankTier(crewRoleLabel(role))]).toEqual([role, tier]);
            expect([role, crewRankTier(crewRoleToFloatPlanRole(role))]).toEqual([role, tier]);
        }
        for (const option of INVITE_ROLE_OPTIONS) {
            expect([option.label, crewRankTier(option.label)]).toEqual([option.label, expected[option.role]]);
        }
        // The crewing view's own words for the skipper and an unknown role.
        expect(crewRankTier('skipper')).toBe('skipper');
        expect(crewRankTier(crewRoleLabel('skipper'))).toBe('skipper');
        expect(crewRankTier(crewRoleLabel('crew'))).toBe('crew');
        expect(crewRankTier(crewRoleLabel(null))).toBe('crew');
    });

    it("agrees with the seniority a person's several invite rows resolve by", () => {
        const bySeniority = Object.keys(CREW_ROLE_SENIORITY).sort(
            (a, b) => CREW_ROLE_SENIORITY[b] - CREW_ROLE_SENIORITY[a],
        );
        expect(sortByCrewRank(bySeniority, (role) => ({ role }))).toEqual(bySeniority);
    });
});

describe('crewRankTier — what a skipper types in his vessel profile', () => {
    it('captain, master and skipper are the Skipper', () => {
        expectTier('skipper', [
            'Skipper',
            'skipper',
            'SKIPPER',
            'Skip',
            'Captain',
            'Capt',
            'Capt.',
            "Cap'n",
            'Master',
            'Cap',
        ]);
    });

    it('co-skipper, co-captain and relief skipper are the Co-skipper', () => {
        expectTier('co-skipper', [
            'Co-skipper',
            'co skipper',
            'Co Skipper',
            'coskipper',
            'CO-SKIPPER',
            'Co_Skipper',
            'Co-captain',
            'co captain',
            'Cocaptain',
            'Relief skipper',
            'Relief Captain',
            'Second skipper',
            '2nd skipper',
            'Second captain',
            'Deputy skipper',
            'Deputy captain',
            'Vice captain',
            'Vice-skipper',
            'Assistant skipper',
            // The app calls the Co-skipper its second-in-command (FLOAT_PLAN_ROLES).
            '2IC',
            '2 I/C',
            'Second in command',
            'Second-in-command',
            '2nd in command',
        ]);
    });

    it('first mate, mate and chief mate are the First mate', () => {
        expectTier('first-mate', [
            'First mate',
            'first-mate',
            'First Mate',
            '1st mate',
            '1st Mate',
            'Mate',
            'Chief mate',
            'Chief officer',
            'First officer',
        ]);
    });

    it('navigators', () => {
        expectTier('navigator', ['Navigator', 'NAVIGATOR', 'Nav', 'Navigation officer']);
    });

    it('engineer, bosun and watch captain rank together, below the navigator', () => {
        expectTier('officer', [
            'Engineer',
            'Chief engineer',
            'Mechanic',
            'Bosun',
            "Bos'n",
            'Bos’n',
            'Boatswain',
            'Watch captain',
            'Watch Captain',
            'watch-captain',
            'Watch leader',
            'Second mate',
            '2nd mate',
            'Third mate',
            'Fourth mate',
            // An abbreviated watch captain is still not the captain (review 2026-10-07).
            'Watch capt',
            'Watch Capt.',
            'Watch cpt',
            'Watch skipper',
            'Starboard watch capt',
            // A bosun's or engineer's mate is their hand, not the First mate.
            "Bosun's mate",
            'Bosuns mate',
            "Bos'n's mate",
            "Boatswain's mate",
            "Engineer's mate",
        ]);
    });

    it('cook and radio operator rank together, below the officers', () => {
        expectTier('specialist', [
            'Cook',
            'Chef',
            "Ship's cook",
            "Cook's mate",
            'Radio operator',
            'Radio Operator',
            'radio-operator',
        ]);
    });

    it('deckhand and crew, and any rank it does not know, are Crew', () => {
        expectTier('crew', ['Deckhand', 'Deck hand', 'deck-hand', 'Crew', 'crew member', 'Hand', 'Sailor']);
        expectTier('crew', ['Helmsman', 'Grinder', 'Bowman', 'Trimmer', 'Photographer', 'Quartermaster', 'xyz']);
        // Learning the skipper's job is not doing it.
        expectTier('crew', ['Trainee skipper', 'Trainee captain', 'Apprentice skipper', 'Junior skipper']);
        expect(crewRankTier('')).toBe('crew');
        expect(crewRankTier('   ')).toBe('crew');
        expect(crewRankTier(null)).toBe('crew');
        expect(crewRankTier(undefined)).toBe('crew');
        expect(crewRankTier('—')).toBe('crew');
    });

    it('punter, guest, passenger and child are aboard, not crewing: last', () => {
        expectTier('guest', ['Punter', 'Guest', 'GUEST', 'Passenger', 'Pax', 'Child', 'Kid', 'Infant', 'Visitor']);
    });

    it('ignores case, spacing, punctuation and accents', () => {
        expectTier('co-skipper', ['  co   SKIPPER  ', 'co\tskipper', 'Co - Skipper', 'co.skipper', 'Có-skipper']);
        expectTier('first-mate', ['FIRST  MATE', 'first\nmate', '(First mate)', 'first mate.']);
        expectTier('navigator', ['Navigàtor', ' navigator ']);
    });

    it('reads a rank written with more words by the most senior known words in it, not words inside longer ones', () => {
        // Exact words first: a watch captain is not the captain.
        expect(crewRankTier('Port watch captain')).toBe('officer');
        expect(crewRankTier('Navigator / Watch capt')).toBe('navigator');
        expect(crewRankTier('Navigator / watch captain')).toBe('navigator');
        expect(crewRankTier('Mate & radio operator')).toBe('first-mate');
        expect(crewRankTier('Skipper / crew member')).toBe('skipper');
        expect(crewRankTier('Deckhand (trainee skipper)')).toBe('crew');
        expect(crewRankTier("Cook's mate & deckhand")).toBe('specialist');
        expect(crewRankTier('First mate & cook')).toBe('first-mate');
        expect(crewRankTier('Co-skipper / navigator')).toBe('co-skipper');
        expect(crewRankTier('Skipper / owner')).toBe('skipper');
        expect(crewRankTier('Owner & skipper')).toBe('skipper');
        expect(crewRankTier('Mate/Cook')).toBe('first-mate');
        expect(crewRankTier('Guest chef')).toBe('specialist');
        expect(crewRankTier("Captain's guest")).toBe('guest');
        expect(crewRankTier('Child (9)')).toBe('guest');
        expect(crewRankTier('Junior crew')).toBe('crew');
    });

    it('orders the tiers as decided', () => {
        expect(CREW_RANK_TIERS).toEqual([
            'skipper',
            'co-skipper',
            'first-mate',
            'navigator',
            'officer',
            'specialist',
            'crew',
            'guest',
        ]);
        expect(crewRankOrder('Skipper')).toBe(0);
        expect(crewRankOrder('Punter')).toBe(7);
        expect(crewRankOrder('Something new')).toBe(crewRankOrder('Crew'));
    });
});

describe('sortByCrewRank', () => {
    const person = (name: string, role?: string) => ({ name, role });
    const names = (people: Array<{ name: string }>) => people.map((p) => p.name);

    it('lists everyone in the decided order, whatever order they arrived in', () => {
        const aboard = [
            person('Pat Punter', 'Punter'),
            person('Dee Hand', 'Deckhand'),
            person('Rae Radio', 'Radio operator'),
            person('Bo Bosun', 'Bosun'),
            person('Nia Nav', 'Navigator'),
            person('Fay Mate', 'First mate'),
            person('Cole Skip', 'Co-skipper'),
            person('Sky Per', 'Skipper'),
            person('Gus Guest', 'Guest'),
            person('Cy Cook', 'Cook'),
            person('Wes Watch', 'Watch captain'),
            person('Eve Eng', 'Engineer'),
            person('Cam Crew', 'Crew'),
            person('Pia Pass', 'Passenger'),
        ];
        expect(names(sortByCrewRank(aboard))).toEqual([
            'Sky Per',
            'Cole Skip',
            'Fay Mate',
            'Nia Nav',
            'Bo Bosun',
            'Eve Eng',
            'Wes Watch',
            'Cy Cook',
            'Rae Radio',
            'Cam Crew',
            'Dee Hand',
            'Gus Guest',
            'Pat Punter',
            'Pia Pass',
        ]);
    });

    it('a punter invited first still lists after the First mate (Shane 2026-10-07)', () => {
        expect(
            names(
                sortByCrewRank([
                    person('Tom Okafor', 'Punter'),
                    person('Ana Reyes', 'Skipper'),
                    person('Priya Nair', 'First mate'),
                ]),
            ),
        ).toEqual(['Ana Reyes', 'Priya Nair', 'Tom Okafor']);
    });

    it('captain, first mate and the co-skipper invitee: the co-skipper is second', () => {
        expect(
            names(
                sortByCrewRank([
                    person('Ana Reyes', 'Captain'),
                    person('Priya Nair', 'First mate'),
                    person('Tom Okafor', 'Co-skipper'),
                ]),
            ),
        ).toEqual(['Ana Reyes', 'Tom Okafor', 'Priya Nair']);
    });

    it('breaks a tie by name, case-insensitively and in the locale, accents beside their letter', () => {
        expect(
            names(
                sortByCrewRank([
                    person('zoe Lane', 'Crew'),
                    person('Émile Roux', 'Crew'),
                    person('ben Ito', 'Crew'),
                    person('Ana Diaz', 'Crew'),
                    person('Fred Cho', 'Crew'),
                ]),
            ),
        ).toEqual(['Ana Diaz', 'ben Ito', 'Émile Roux', 'Fred Cho', 'zoe Lane']);
        // Numbers as numbers.
        expect(names(sortByCrewRank([person('Guest 10', 'Guest'), person('Guest 2', 'Guest')]))).toEqual([
            'Guest 2',
            'Guest 10',
        ]);
    });

    it('keeps the order people arrived in when rank and name tie, both ways round', () => {
        const a = { name: 'Sam Lee', role: 'Deckhand', id: 'a' };
        const b = { name: 'sam lee', role: 'deckhand', id: 'b' };
        const c = { name: 'Sam  Lee ', role: 'Crew', id: 'c' };
        expect(sortByCrewRank([a, b, c]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
        expect(sortByCrewRank([c, b, a]).map((p) => p.id)).toEqual(['c', 'b', 'a']);
    });

    it('ranks unknown ranks with the Crew, after the cook and before the guests', () => {
        expect(
            names(
                sortByCrewRank([
                    person('Gil Guest', 'Guest'),
                    person('Zed Helm', 'Helmsman'),
                    person('Amy Crew', 'Crew'),
                    person('Bob Grinder', 'Grinder'),
                    person('Nobody Said', undefined),
                    person('Cy Cook', 'Cook'),
                ]),
            ),
        ).toEqual(['Cy Cook', 'Amy Crew', 'Bob Grinder', 'Nobody Said', 'Zed Helm', 'Gil Guest']);
    });

    it('puts a person with no name yet after the named people of their rank', () => {
        expect(
            sortByCrewRank([person('', 'Skipper'), person('', 'Crew'), person('Ana', 'Crew'), person('Bo', 'Skipper')]),
        ).toEqual([person('Bo', 'Skipper'), person('', 'Skipper'), person('Ana', 'Crew'), person('', 'Crew')]);
    });

    it('does not move "you": the reader sits at their rank like anyone else', () => {
        const aboard = [
            { name: 'Tom Okafor', role: 'Deckhand', isSelf: true },
            { name: 'Ana Reyes', role: 'Skipper', isSelf: false },
            { name: 'Lena Park', role: 'Navigator', isSelf: false },
        ];
        expect(sortByCrewRank(aboard).map((p) => [p.name, p.isSelf])).toEqual([
            ['Ana Reyes', false],
            ['Lena Park', false],
            ['Tom Okafor', true],
        ]);
    });

    it('returns a new list of the same people, their rank text untouched', () => {
        const aboard = [person('Pat', 'punter'), person('Ana', 'CAPTAIN'), person('Bo', 'co skipper')];
        const before = [...aboard];
        const sorted = sortByCrewRank(aboard);
        expect(aboard).toEqual(before);
        expect(sorted).not.toBe(aboard);
        expect(sorted).toEqual([aboard[1], aboard[2], aboard[0]]);
        expect(sorted[0]).toBe(aboard[1]);
        expect(sorted.map((p) => p.role)).toEqual(['CAPTAIN', 'co skipper', 'punter']);
        expect(sortByCrewRank([])).toEqual([]);
    });

    it('reads role and name through a picker when they live elsewhere', () => {
        const rows = [
            { who: 'Pat', rank: { label: 'Guest' } },
            { who: 'Ana', rank: { label: 'Skipper' } },
        ];
        expect(sortByCrewRank(rows, (row) => ({ role: row.rank.label, name: row.who })).map((row) => row.who)).toEqual([
            'Ana',
            'Pat',
        ]);
    });
});
