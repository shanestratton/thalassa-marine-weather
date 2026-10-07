/**
 * crewRank — the one order people aboard are listed in (Shane 2026-10-07: "in
 * the float plan ... can we order the punters on board by their rank?").
 *
 *   Skipper → Co-skipper → First mate → Navigator
 *     → Engineer / Bosun / Watch captain → Cook / Radio operator
 *     → Deckhand / Crew (and any rank it does not recognise)
 *     → Punter / Guest / Passenger
 *
 * Ties go by name (the device's locale, case-insensitive), then by the order
 * the list arrived in, so equal people never swap places between renders.
 *
 * EVERY list of people aboard sorts with sortByCrewRank — the skipper's Float
 * Plan sheet, the text, email and PDF it sends (prepareFloatPlan), and the
 * crew's own "Crew aboard" and float plan card (crewVesselPeople) — so no two
 * of them can disagree about who comes first. Nobody is moved for being the
 * reader: "you" sits at your rank like anyone else.
 *
 * Ranks arrive two ways: invite roles ('co-skipper', 'navigator', 'deckhand',
 * 'punter', and the labels the app shows for them) and the free-text rank the
 * skipper typed against each person in his vessel profile ("Captain", "Mate",
 * "Bos'n"). Both are read here, case- and spacing-insensitively, and the
 * displayed text is never changed. The words are English today; this table is
 * the one place to add another language's.
 *
 * Pure and import-free, like floatPlanPeople: the Vessel hub and the plain
 * text float plan can use it without loading Supabase or React.
 */

/** Rank tiers, most senior first. A tier is an ORDER, not a label to show. */
export const CREW_RANK_TIERS = [
    'skipper',
    'co-skipper',
    'first-mate',
    'navigator',
    /** Engineer, bosun, watch captain, second mate: officers below the navigator. */
    'officer',
    /** Cook, radio operator: specialist hands. */
    'specialist',
    /** Deckhand, crew, and any rank this table does not recognise. */
    'crew',
    /** Punter, guest, passenger, child: aboard, not crewing. */
    'guest',
] as const;

export type CrewRankTier = (typeof CREW_RANK_TIERS)[number];

/**
 * What each tier is called, written as the normalised words it is read from
 * (lower case, accents and apostrophes dropped, anything else between words
 * a single space): "Co-Skipper", "co skipper" and "CO_SKIPPER" all read as
 * "co skipper"; "Bos'n" reads as "bosn". Add a language's words here.
 */
const CREW_RANK_WORDS: Readonly<Record<CrewRankTier, readonly string[]>> = {
    skipper: [
        'skipper',
        'skip',
        'captain',
        'capt',
        'capn',
        'cpt',
        'cap',
        'master',
        'ship master',
        'shipmaster',
        'owner skipper',
        'skipper owner',
    ],
    'co-skipper': [
        'co skipper',
        'coskipper',
        'co skip',
        'co captain',
        'cocaptain',
        'co capt',
        'relief skipper',
        'relief captain',
        'relief master',
        'second skipper',
        '2nd skipper',
        'second captain',
        '2nd captain',
        'deputy skipper',
        'deputy captain',
        'vice skipper',
        'vice captain',
        'assistant skipper',
        'assistant captain',
        // The app's own second-in-command is the Co-skipper (FLOAT_PLAN_ROLES).
        'second in command',
        '2nd in command',
        '2ic',
        '2 i c',
    ],
    'first-mate': ['first mate', '1st mate', 'mate', 'chief mate', 'first officer', '1st officer', 'chief officer'],
    navigator: ['navigator', 'nav', 'navigation officer', 'navigating officer'],
    officer: [
        'engineer',
        'chief engineer',
        'mechanic',
        'bosun',
        'bosn',
        'boatswain',
        'watch captain',
        'watch capt',
        'watch cpt',
        'watch skipper',
        'watch leader',
        'watch officer',
        'second mate',
        '2nd mate',
        'third mate',
        '3rd mate',
        'fourth mate',
        '4th mate',
        // A mate of someone below the First mate is that someone's hand, not
        // the First mate ("Bos'n's mate" reads "bosns mate").
        'bosuns mate',
        'bosns mate',
        'boatswains mate',
        'engineers mate',
    ],
    specialist: [
        'cook',
        'chef',
        'ships cook',
        'cooks mate',
        'radio operator',
        'radio officer',
        'radio',
        'sparks',
        'communications officer',
    ],
    crew: [
        'crew',
        'deckhand',
        'deck hand',
        'hand',
        'crew member',
        'crewmember',
        'crewman',
        'sailor',
        'seaman',
        // Learning the job, not doing it: crew until the skipper says otherwise.
        'trainee skipper',
        'trainee captain',
        'apprentice skipper',
        'junior skipper',
    ],
    guest: [
        'punter',
        'guest',
        'passenger',
        'pax',
        'visitor',
        'child',
        'kid',
        'infant',
        'baby',
        'toddler',
        'minor',
        'charter guest',
    ],
};

/** Normalised words → tier, built once. */
const WORD_TIER: ReadonlyMap<string, CrewRankTier> = (() => {
    const map = new Map<string, CrewRankTier>();
    for (const tier of CREW_RANK_TIERS) for (const words of CREW_RANK_WORDS[tier]) map.set(words, tier);
    return map;
})();

/** The same phrases split into words, each with its tier's place in CREW_RANK_TIERS. */
const PHRASE_TIERS: ReadonlyArray<readonly [readonly string[], number]> = [...WORD_TIER].map(
    ([phrase, tier]) => [phrase.split(' '), CREW_RANK_TIERS.indexOf(tier)] as const,
);

/** Lower case, accents and apostrophes dropped, every other run of non-letters a single space. */
function normaliseRank(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/['‘’ʼ`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * The tier a role or rank reads as. Exact words first ("Watch captain" is an
 * officer, not a skipper). Otherwise every known phrase inside it, less any
 * that only sits inside a longer known phrase ("Port watch captain" is a
 * watch captain, not a captain; "Bosun's mate" a bosun's mate, not the mate),
 * and the most senior of what is left ("Mate/Cook" is the mate, "Navigator /
 * watch capt" the navigator). Nothing known — or nothing at all — is Crew.
 */
export function crewRankTier(role: string | null | undefined): CrewRankTier {
    const text = typeof role === 'string' ? normaliseRank(role) : '';
    if (!text) return 'crew';
    const exact = WORD_TIER.get(text);
    if (exact) return exact;

    const words = text.split(' ');
    const found: Array<{ tier: number; start: number; end: number }> = [];
    for (const [phrase, tier] of PHRASE_TIERS) {
        for (let start = 0; start + phrase.length <= words.length; start += 1) {
            if (phrase.every((word, k) => words[start + k] === word)) {
                found.push({ tier, start, end: start + phrase.length });
            }
        }
    }
    let best = -1;
    for (const match of found) {
        const inside = found.some(
            (other) =>
                other.end - other.start > match.end - match.start &&
                other.start <= match.start &&
                other.end >= match.end,
        );
        if (!inside && (best < 0 || match.tier < best)) best = match.tier;
    }
    return best < 0 ? 'crew' : CREW_RANK_TIERS[best];
}

/** 0 for a skipper, rising to the guests; what sortByCrewRank orders by first. */
export function crewRankOrder(role: string | null | undefined): number {
    return CREW_RANK_TIERS.indexOf(crewRankTier(role));
}

/** What sortByCrewRank reads from each person. */
export interface CrewRankKey {
    role?: string | null;
    name?: string | null;
}

let collator: Intl.Collator | null = null;

/**
 * Names in the device's locale, case-insensitively ("ana" and "Ana" tie and
 * keep their order), numbers as numbers. A person with no name yet sorts
 * after the named people of their rank.
 */
function compareNames(a: string, b: string): number {
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    collator ??= new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true });
    return collator.compare(a, b);
}

/**
 * People in rank order: by tier, then by name, then as they arrived. Returns
 * a new array; the input is not touched. `read` picks the role and name out of
 * each item when they are not its own `role` and `name` fields.
 */
export function sortByCrewRank<T extends CrewRankKey>(people: readonly T[]): T[];
export function sortByCrewRank<T>(people: readonly T[], read: (person: T) => CrewRankKey): T[];
export function sortByCrewRank<T>(people: readonly T[], read?: (person: T) => CrewRankKey): T[] {
    const keyOf = read ?? ((person: T) => person as CrewRankKey);
    return people
        .map((person, index) => {
            const key = keyOf(person);
            const name = typeof key.name === 'string' ? key.name.trim().replace(/\s+/g, ' ') : '';
            return { person, index, order: crewRankOrder(key.role), name };
        })
        .sort((a, b) => a.order - b.order || compareNames(a.name, b.name) || a.index - b.index)
        .map((entry) => entry.person);
}
