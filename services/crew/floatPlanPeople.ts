/**
 * floatPlanPeople — everyone aboard, each person once (Shane 2026-10-04: "the
 * invitee needs to use the name and phone number and age from the vessel
 * profile in settings for the float plan, also the number of pob's needs to
 * include the invitee as well as the others on board").
 *
 * Two lists name the people on a boat: the skipper's vessel-profile roster
 * (what he typed under Crew) and the app crew (the skipper plus accepted
 * invitees). The same person is often on both, typed differently ("Tom",
 * "Tom Okafor", "Capt Ana Reyes"), and must be counted once. An invitee's own
 * name, phone and age (from their own Settings) win over the skipper's typing.
 *
 * Pure (its one import, ./dateOfBirth, is too): the Vessel hub counts with it
 * without loading Supabase.
 *
 * Ages come from a date of birth since 129-14 (Shane 2026-10-14: "can we
 * change punters age for date of birth. Otherwise we will have to change the
 * age every year"), worked out on the day asked: today for the editor and
 * the invitee's share, the departure day for the float plan. An age typed
 * before 129 stands until someone enters a date of birth; a date of birth is
 * never guessed from it.
 */
import { ageOn, isBirthDate, localDay } from './dateOfBirth';

/**
 * How senior each app crew role is, for the one role a person with several
 * vessel_crew rows carries: the order get_crew_vessel_view (20261003120000)
 * ranks them in. One map for both devices, so the skipper's float plan and
 * the crew's own view of the boat cannot drift apart. The order a LIST of
 * people is shown in is crewRank.ts; tests/crewRank.test.ts holds the two in
 * step.
 */
export const CREW_ROLE_SENIORITY: Readonly<Record<string, number>> = Object.freeze({
    'co-skipper': 4,
    navigator: 3,
    deckhand: 2,
    punter: 1,
});

export interface FloatPlanSelfDetails {
    name: string | null;
    phone: string | null;
    /** On the day the details were read for: today for a share, the departure day on the skipper's plan. */
    age: number | null;
    /**
     * yyyy-mm-dd, present only when the person entered one (129-14). Shared
     * with the skipper and nobody else, as age is; it stops at the skipper's
     * loader (services/floatPlanCrew.ts), and the plan prints the age only.
     */
    dateOfBirth?: string | null;
}

/** One person's date-of-birth and age fields, as the vessel profile and the shared details hold them. */
export interface AgedPerson {
    age?: unknown;
    dateOfBirth?: unknown;
}

/**
 * A person's age on `onDay` (yyyy-mm-dd): from their date of birth when it is
 * one, else the age typed before 129. 1-120, else null: a baby under one has
 * no age to print, as before.
 */
export function personAge(person: AgedPerson | null | undefined, onDay: string): number | null {
    const dateOfBirth = person?.dateOfBirth;
    const age = isBirthDate(dateOfBirth) ? ageOn(dateOfBirth, onDay) : person?.age;
    return typeof age === 'number' && Number.isFinite(age) && age >= 1 && age <= 120 ? Math.round(age) : null;
}

/** A date of birth worth sharing: a real date, not after `onDay`. */
function birthDateOn(value: unknown, onDay: string): string | null {
    return isBirthDate(value) && ageOn(value, onDay) !== null ? value : null;
}

/** One person from the app crew. */
export interface AppCrewPerson {
    /** The name the app knows them by (boat_members, sign-up); '' when unknown. */
    appName: string;
    /** Their own name from their Settings, shared for the float plan. Wins. */
    ownName?: string | null;
    role: string;
    isSkipper?: boolean;
    isSelf?: boolean;
    crewUserId?: string | null;
    age?: number | null;
    phone?: string | null;
}

export interface AboardPerson {
    name: string;
    role: string;
    age: number | null;
    phone: string | null;
    crewUserId: string | null;
    isSelf: boolean;
    /** Not on the skipper's own list: joined from the app crew. */
    added: boolean;
}

/**
 * The invitee's own details, from THEIR Settings → Vessel Profile: on their
 * own profile they are the skipper, so the Crew row ranked Skipper is theirs
 * (the first row, which VesselTab ranks Skipper unless they changed it), and
 * "Skipper mobile" is their phone. Nulls where nothing usable is set.
 */
export function floatPlanSelfDetails(
    vessel:
        | {
              contactPhone?: string;
              crewRoster?: Array<{ name?: string; age?: number; dateOfBirth?: string; rank?: string }>;
          }
        | null
        | undefined,
    onDay: string = localDay(),
): FloatPlanSelfDetails {
    const roster = vessel?.crewRoster ?? [];
    const me = roster.find((row) => row?.rank?.trim().toLowerCase() === 'skipper') ?? roster[0];
    const clean = (value: unknown, max: number) =>
        typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) || null : null;
    const dateOfBirth = birthDateOn(me?.dateOfBirth, onDay);
    return {
        name: clean(me?.name, 120),
        phone: clean(vessel?.contactPhone, 40),
        age: personAge(me, onDay),
        // Only when there is one, so an age-only share reads as it always did.
        ...(dateOfBirth ? { dateOfBirth } : {}),
    };
}

const TITLES = new Set([
    'capt',
    'captain',
    'skipper',
    'skip',
    'mr',
    'mrs',
    'ms',
    'miss',
    'mx',
    'dr',
    'prof',
    'sir',
    'rev',
]);

/**
 * Lower-cased name words, without a quoted "nickname" or a leading title.
 * Accents and apostrophes (straight or curly) are dropped and a hyphen splits
 * words, so "Zoë O’Brien-Lee" and "Zoe OBrien Lee" are one person.
 */
function words(name: string | null | undefined): string[] {
    const list = (name ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/["“”][^"“”]*["“”]/g, ' ')
        .replace(/['‘’ʼ]/g, '')
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    while (list.length > 1 && TITLES.has(list[0])) list.shift();
    return list;
}

/**
 * The same full name: equal, or the same first and last name (a middle name
 * typed on one side only), or the tail of the other (a title this list does
 * not know). A lone first name never matches here.
 */
function fullMatch(a: string[], b: string[]): boolean {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length < 2) return short.length === 1 && long.length === 1 && short[0] === long[0];
    if (short[0] === long[0] && short[short.length - 1] === long[long.length - 1]) return true;
    return long.slice(long.length - short.length).join(' ') === short.join(' ');
}

/** "Tom" against "Tom Okafor": a lone first name on one side. */
function firstNameMatch(a: string[], b: string[]): boolean {
    return a.length > 0 && b.length > 0 && (a.length === 1 || b.length === 1) && a[0] === b[0];
}

/**
 * The skipper's named profile rows (in his order), then every app person not
 * already among them. A match takes the app person's own name, phone and age
 * (the skipper's typed age stands in for a missing one) and keeps the rank the
 * skipper chose. The app skipper is the profile's Skipper row. A lone first
 * name merges only when it can be one person on each side; otherwise both are
 * listed, because a float plan one short sends a search home early.
 */
export function mergeAboard(
    profile: ReadonlyArray<{ name: string; role: string; age?: number | null }>,
    app: ReadonlyArray<AppCrewPerson>,
): AboardPerson[] {
    const people: AboardPerson[] = profile.map((row) => ({
        name: row.name,
        role: row.role,
        age: row.age ?? null,
        phone: null,
        crewUserId: null,
        isSelf: false,
        added: false,
    }));
    const rowWords = people.map((row) => words(row.name));
    const taken = new Set<number>();
    const namesOf = (person: AppCrewPerson) => [person.ownName, person.appName].map(words).filter((w) => w.length);
    const take = (index: number, person: AppCrewPerson) => {
        taken.add(index);
        const row = people[index];
        people[index] = {
            name: person.ownName?.trim() || row.name,
            role: row.role,
            age: person.age ?? row.age,
            phone: person.phone ?? null,
            crewUserId: person.crewUserId ?? null,
            isSelf: Boolean(person.isSelf),
            added: false,
        };
    };
    const free = (test: (index: number) => boolean) =>
        rowWords.map((_, i) => i).filter((i) => !taken.has(i) && test(i));

    const unmatched: AppCrewPerson[] = [];
    for (const person of app) {
        const names = namesOf(person);
        const index =
            (person.isSkipper ? free((i) => people[i].role.toLowerCase() === 'skipper')[0] : undefined) ??
            free((i) => names.some((name) => fullMatch(name, rowWords[i])))[0];
        if (index === undefined) unmatched.push(person);
        else take(index, person);
    }

    const extra: AboardPerson[] = [];
    let head: AboardPerson | null = null;
    for (const person of unmatched) {
        const rows = free((i) => namesOf(person).some((name) => firstNameMatch(name, rowWords[i])));
        const rivals = unmatched.filter(
            (other) => rows.length === 1 && namesOf(other).some((name) => firstNameMatch(name, rowWords[rows[0]])),
        );
        if (rows.length === 1 && rivals.length === 1) {
            take(rows[0], person);
            continue;
        }
        const added: AboardPerson = {
            name: person.ownName?.trim() || person.appName.trim(),
            role: person.role,
            age: person.age ?? null,
            phone: person.phone ?? null,
            crewUserId: person.crewUserId ?? null,
            isSelf: Boolean(person.isSelf),
            added: true,
        };
        // An unmatched skipper heads the list; anyone else follows the profile.
        if (person.isSkipper) head = added;
        else extra.push(added);
    }
    return head ? [head, ...people, ...extra] : [...people, ...extra];
}

/**
 * The server does not have crew_float_plan_details yet (migration
 * 20261004120000 not pushed): PostgREST's and Postgres's "no such table" or
 * "no such function". Both sides of the float plan stay quiet on these.
 */
export function isNotPushedYet(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === 'PGRST205' || code === '42P01' || code === 'PGRST202' || code === '42883';
}

/** People aboard: everyone listed, never fewer than the skipper's own "Crew aboard" count. 1–99. */
export function aboardCount(listed: number, declared: number | null | undefined): number {
    const floor = typeof declared === 'number' && Number.isFinite(declared) ? Math.round(declared) : 0;
    return Math.max(1, Math.min(99, Math.max(listed, floor)));
}

/** The vessel profile fields the float plan's people come from. */
export interface ProfileCrewVessel {
    crewCount?: number;
    crewRoster?: Array<{ name: string; age?: number; dateOfBirth?: string; rank?: string }>;
}

/** One of the vessel profile's own people, as the float plan seeds its roster with them. */
export interface ProfileRosterSeed {
    name: string;
    role: string;
    source: 'profile';
    /** On the day asked: the departure day for the float plan. Never the date of birth itself. */
    age: number | null;
}

/**
 * The vessel profile's own people (Shane 2026-09-09) as Float Plan seeds:
 * the rows the skipper typed under "Crew Aboard", named ones only, capped at
 * the crew count, each aged on `onDay` (the plan's departure day; today by
 * default). These outrank the crew-invite list — they are the skipper's own
 * answer to "who is aboard".
 */
export function rosterSeedsFromVesselProfile(
    vessel: ProfileCrewVessel | null | undefined,
    onDay: string = localDay(),
): ProfileRosterSeed[] {
    const rows = vessel?.crewRoster ?? [];
    const cap =
        typeof vessel?.crewCount === 'number' && Number.isFinite(vessel.crewCount)
            ? Math.max(1, Math.min(99, Math.round(vessel.crewCount)))
            : rows.length;
    return rows.slice(0, cap).flatMap((row, index) => {
        const name = (row?.name ?? '').trim();
        if (!name) return [];
        const rank = (row.rank ?? '').trim();
        return [
            {
                name,
                role: rank || (index === 0 ? 'Skipper' : 'Crew'),
                source: 'profile' as const,
                age: personAge(row, onDay),
            },
        ];
    });
}

/**
 * What the merge reads of a crew-list seed (FloatPlanRosterSeed in
 * services/floatPlanCrew.ts), so the count below needs no Supabase.
 */
export interface CrewSeedLike {
    name: string;
    role: string;
    source: string;
    crewUserId?: string | null;
    shared?: { name?: string | null; phone?: string | null; age?: number | null; appName: string };
}

/** A crew-list seed as an app person for mergeAboard: the app's name, theirs, and what they shared. */
export function seedPerson(seed: CrewSeedLike): AppCrewPerson {
    return {
        appName: seed.shared?.appName ?? seed.name,
        ownName: seed.shared?.name,
        role: seed.role,
        isSkipper: seed.source === 'skipper',
        crewUserId: seed.crewUserId,
        age: seed.shared?.age,
        phone: seed.shared?.phone,
    };
}

export interface CrewRegisterCount {
    /** Everyone on the crew register, once: the people aboard and those still invited. */
    crew: number;
    /** Of them, how many have an invite they have not answered yet. */
    invited: number;
}

/**
 * The Crew & Float Plan card's count (129-14, Shane 2026-10-14: "the crew and
 * float plan card says two crew. But there is actually three. 2+1 invitee").
 * Everyone on the crew register, each person once by the float plan's own
 * rule (mergeAboard): the profile's people with the skipper and accepted crew
 * (exactly the float plan's people aboard), then pending invitees not already
 * among them; never fewer than the profile's "Crew aboard" (aboardCount).
 * `invited` is every pending invitee, so the card can say how many have yet
 * to accept. With none, `crew` is the float plan's own count; with some, it
 * is that count once the plan's invite chips are added.
 *
 * Before the crew list answers (signed out, offline), `crew` is null and the
 * profile is counted alone. Null when nothing real is known: no named
 * profile row, no count set, no crew; the skipper alone is never a count.
 *
 * A known limit: until they accept, a pending invitee's name is read from
 * their invite's email (renderCrewDisplayName), so they match the profile row
 * the skipper typed for them only when the email reads as first.last or as a
 * first name no one else aboard shares. "aokafor@…" is "Aokafor", counted
 * beside the "Amara Okafor" row until she accepts and her own name matches
 * (tests/CrewRegisterCount.test.ts). The float plan's "Add" chips share it.
 */
export function crewRegisterCount(
    vessel: ProfileCrewVessel | null | undefined,
    crew: { aboard: ReadonlyArray<CrewSeedLike>; invited: ReadonlyArray<CrewSeedLike> } | null | undefined,
): CrewRegisterCount | null {
    const profile = rosterSeedsFromVesselProfile(vessel);
    const aboard = mergeAboard(profile, (crew?.aboard ?? []).map(seedPerson));
    const pending = crew?.invited ?? [];
    const added = mergeAboard(
        aboard.map((person) => ({ name: person.name, role: person.role })),
        pending.map(seedPerson),
    ).filter((person) => person.added).length;
    const declared =
        typeof vessel?.crewCount === 'number' && Number.isFinite(vessel.crewCount) ? vessel.crewCount : null;
    const anyCrew = (crew?.aboard ?? []).some((seed) => seed.source !== 'skipper') || pending.length > 0;
    if (profile.length === 0 && declared === null && !anyCrew) return null;
    return { crew: aboardCount(aboard.length + added, declared), invited: pending.length };
}
