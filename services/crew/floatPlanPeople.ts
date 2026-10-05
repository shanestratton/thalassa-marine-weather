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
 * Pure and import-free: the Vessel hub counts with it without loading Supabase.
 */

export interface FloatPlanSelfDetails {
    name: string | null;
    phone: string | null;
    age: number | null;
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
        | { contactPhone?: string; crewRoster?: Array<{ name?: string; age?: number; rank?: string }> }
        | null
        | undefined,
): FloatPlanSelfDetails {
    const roster = vessel?.crewRoster ?? [];
    const me = roster.find((row) => row?.rank?.trim().toLowerCase() === 'skipper') ?? roster[0];
    const clean = (value: unknown, max: number) =>
        typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) || null : null;
    const age = me?.age;
    return {
        name: clean(me?.name, 120),
        phone: clean(vessel?.contactPhone, 40),
        age: typeof age === 'number' && Number.isFinite(age) && age >= 1 && age <= 120 ? Math.round(age) : null,
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
