/**
 * Customs port index: the small, synchronous part of the customs guide.
 *
 * Whether a passage needs customs at all is decided while screens render
 * (isSameCountry, read by CrewManagement's cast-off gate and the readiness
 * card stack), so this module holds only what that needs: each covered
 * country's name, flag and designated ports of entry, and the shorthand
 * aliases skippers and passage plans use. A few KB.
 *
 * The clearance guide itself (procedures, contacts, documents, fees, notes)
 * is data: public/data/customs-clearance.json, loaded when the customs card
 * opens (data/customsDb.ts). Build 126 split the old data/customsDb.ts this
 * way to take about 40 KB of prose out of the JavaScript. A country needs an
 * entry here AND in the JSON, under the same key, in the same order.
 *
 * tests/CustomsPortIndex.test.ts holds every recorded port and pair to a
 * baseline, re-baselined once on purpose when names began to match as whole
 * words (130-09); each answer that changed is listed there.
 */

export interface CustomsCountry {
    country: string;
    flag: string;
    portsOfEntry: readonly string[];
}

export const CUSTOMS_PORT_INDEX: Readonly<Record<string, CustomsCountry>> = {
    australia: {
        country: 'Australia',
        flag: '🇦🇺',
        portsOfEntry: [
            'Cairns',
            'Townsville',
            'Bundaberg',
            'Brisbane',
            'Gold Coast (Southport)',
            'Sydney',
            'Coffs Harbour',
            'Newcastle',
            'Darwin',
            'Thursday Island',
        ],
    },
    'new zealand': {
        country: 'New Zealand',
        flag: '🇳🇿',
        portsOfEntry: ['Opua', 'Whangarei', 'Auckland', 'Tauranga', 'Napier', 'Wellington', 'Nelson', 'Lyttelton'],
    },
    indonesia: {
        country: 'Indonesia',
        flag: '🇮🇩',
        portsOfEntry: ['Sabang', 'Batam', 'Jakarta (Tanjung Priok)', 'Bali (Benoa)', 'Kupang', 'Jayapura', 'Manado'],
    },
    fiji: { country: 'Fiji', flag: '🇫🇯', portsOfEntry: ['Suva', 'Lautoka', 'Levuka', 'Savusavu'] },
    'papua new guinea': {
        country: 'Papua New Guinea',
        flag: '🇵🇬',
        portsOfEntry: ['Port Moresby', 'Lae', 'Madang', 'Rabaul', 'Kavieng', 'Alotau'],
    },
    'united states': {
        country: 'United States',
        flag: '🇺🇸',
        portsOfEntry: ['San Diego', 'Los Angeles', 'San Francisco', 'Honolulu', 'Miami', 'Key West', 'New York'],
    },
    // Pacific islands
    vanuatu: { country: 'Vanuatu', flag: '🇻🇺', portsOfEntry: ['Port Vila', 'Luganville (Santo)'] },
    'new caledonia': {
        country: 'New Caledonia',
        flag: '🇳🇨',
        portsOfEntry: ['Nouméa (Port Moselle)', 'Lifou', 'Wé (Maré)'],
    },
    'cook islands': {
        country: 'Cook Islands',
        flag: '🇨🇰',
        portsOfEntry: ['Avatiu (Rarotonga)', 'Penrhyn', 'Aitutaki'],
    },
    'french polynesia': {
        country: 'French Polynesia',
        flag: '🇵🇫',
        portsOfEntry: ['Papeete (Tahiti)', 'Nuku Hiva (Marquesas)', 'Rikitea (Gambier)', 'Raiatea'],
    },
    // Europe and the Mediterranean
    france: {
        country: 'France',
        flag: '🇫🇷',
        portsOfEntry: ['Marseille', 'Toulon', 'Nice', 'Cannes', 'La Rochelle', 'Brest', 'Cherbourg', 'Antibes'],
    },
    'united kingdom': {
        country: 'United Kingdom',
        flag: '🇬🇧',
        portsOfEntry: [
            'Southampton',
            'Portsmouth',
            'Plymouth',
            'Falmouth',
            'Dover',
            'London (St Katharine Docks)',
            'Edinburgh (Granton)',
        ],
    },
    // Alias record for "England" (its own guide entry, same country)
    england: {
        country: 'United Kingdom',
        flag: '🇬🇧',
        portsOfEntry: ['Southampton', 'Portsmouth', 'Plymouth', 'Falmouth', 'Dover'],
    },
    türkiye: {
        country: 'Türkiye',
        flag: '🇹🇷',
        portsOfEntry: ['Marmaris', 'Bodrum', 'Fethiye', 'Antalya', 'İzmir (Çeşme)', 'Kuşadası', 'Kaş', 'Finike'],
    },
    // Alias record for "Turkey" (its own guide entry, same country)
    turkey: { country: 'Türkiye', flag: '🇹🇷', portsOfEntry: ['Marmaris', 'Bodrum', 'Fethiye', 'Antalya', 'İzmir'] },
    greece: {
        country: 'Greece',
        flag: '🇬🇷',
        portsOfEntry: [
            'Piraeus (Athens)',
            'Rhodes',
            'Corfu (Kerkyra)',
            'Kos',
            'Heraklion (Crete)',
            'Thessaloniki',
            'Zakynthos',
            'Syros',
        ],
    },
    italy: {
        country: 'Italy',
        flag: '🇮🇹',
        portsOfEntry: [
            'Genoa',
            'Naples',
            'Palermo',
            'Cagliari (Sardinia)',
            'Venice',
            'Brindisi',
            'Catania',
            'Olbia',
            'Civitavecchia (Rome)',
        ],
    },
    spain: {
        country: 'Spain',
        flag: '🇪🇸',
        portsOfEntry: [
            'Barcelona',
            'Palma de Mallorca',
            'Valencia',
            'Alicante',
            'Gibraltar (UK)',
            'Málaga',
            'Las Palmas (Canaries)',
            'Ibiza',
        ],
    },
    croatia: {
        country: 'Croatia',
        flag: '🇭🇷',
        portsOfEntry: ['Split', 'Dubrovnik', 'Zadar', 'Rijeka', 'Pula', 'Šibenik', 'Korčula'],
    },
    montenegro: { country: 'Montenegro', flag: '🇲🇪', portsOfEntry: ['Kotor', 'Bar', 'Budva', 'Tivat'] },
    malta: { country: 'Malta', flag: '🇲🇹', portsOfEntry: ['Valletta (Grand Harbour)', 'Msida Marina', 'Gozo (Mġarr)'] },
    cyprus: { country: 'Cyprus', flag: '🇨🇾', portsOfEntry: ['Larnaca', 'Limassol', 'Paphos'] },
    portugal: {
        country: 'Portugal',
        flag: '🇵🇹',
        portsOfEntry: ['Lisbon', 'Lagos', 'Cascais', 'Porto (Leixões)', 'Horta (Azores)', 'Funchal (Madeira)'],
    },
    // Caribbean
    'british virgin islands': {
        country: 'British Virgin Islands',
        flag: '🇻🇬',
        portsOfEntry: ['Road Town (Tortola)', 'Jost Van Dyke', 'Virgin Gorda', 'Anegada'],
    },
    'antigua and barbuda': {
        country: 'Antigua and Barbuda',
        flag: '🇦🇬',
        portsOfEntry: ['English Harbour', "St John's", 'Jolly Harbour'],
    },
    'saint lucia': {
        country: 'Saint Lucia',
        flag: '🇱🇨',
        portsOfEntry: ['Rodney Bay', 'Castries', 'Marigot Bay', 'Soufrière'],
    },
    grenada: {
        country: 'Grenada',
        flag: '🇬🇩',
        portsOfEntry: ["St George's (Port Louis)", 'Prickly Bay', 'Hillsborough (Carriacou)'],
    },
    'sint maarten': {
        country: 'Sint Maarten',
        flag: '🇸🇽',
        portsOfEntry: ['Simpson Bay (Dutch)', 'Philipsburg (Dutch)', 'Marigot (French)'],
    },
    bahamas: {
        country: 'Bahamas',
        flag: '🇧🇸',
        portsOfEntry: [
            'Nassau',
            'Marsh Harbour (Abacos)',
            'George Town (Exumas)',
            'Freeport (Grand Bahama)',
            'Spanish Wells',
        ],
    },
};

/* ── Aliases ──────────────────────────────────────────────────── */

// The United States by its states' full names (132, Shane 2026-10-15), so
// 'Newport, Rhode Island' and 'Santa Cruz, California' find its guide. Full
// names only: the two-letter codes clash here ('NC' is New Caledonia, 'WA'
// would be Western Australia, 'CA' Canada). Georgia is left out: it is also a
// country on the Black Sea, which the index does not cover.
const US_STATES = `alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii
    idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota
    mississippi missouri montana nebraska nevada new_hampshire new_jersey new_mexico new_york north_carolina
    north_dakota ohio oklahoma oregon pennsylvania rhode_island south_carolina south_dakota tennessee texas
    utah vermont virginia washington west_virginia wisconsin wyoming`;

// Places the index does not cover whose names hold a state's: Mexico's Baja
// California and Gulf of California, the Solomons' Florida Islands. Named,
// they leave the port unplaced rather than in the United States.
const ELSEWHERE = ['baja california', 'gulf of california', 'florida islands'];

// Common name aliases so free-text country and port names from passage plans
// match our keys. Each matches as whole words only (130-09): 'sa' is found in
// 'Adelaide, SA', never inside 'Santa Cruz'.
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
    // Australian states (so 'Newport, QLD' resolves to Australia; 'Newport'
    // alone is a port the index cannot place).
    qld: 'australia',
    queensland: 'australia',
    nsw: 'australia',
    'new south wales': 'australia',
    vic: 'australia',
    victoria: 'australia',
    tas: 'australia',
    tasmania: 'australia',
    sa: 'australia',
    'south australia': 'australia',
    nt: 'australia',
    'northern territory': 'australia',
    act: 'australia',
    // 'wa' is omitted: too easily confused with Washington State USA.
    // 'Western Australia' is full enough to disambiguate.
    'western australia': 'australia',
    // New Caledonia (NC) — common shorthand on cruising charts.
    nc: 'new caledonia',
    'new cal': 'new caledonia',
    noumea: 'new caledonia',
    // Other countries
    tahiti: 'french polynesia',
    'french poly': 'french polynesia',
    bvi: 'british virgin islands',
    'virgin islands': 'british virgin islands',
    'st lucia': 'saint lucia',
    'st. lucia': 'saint lucia',
    'st maarten': 'sint maarten',
    'st. maarten': 'sint maarten',
    'saint martin': 'sint maarten',
    'saint-martin': 'sint maarten',
    uk: 'united kingdom',
    'great britain': 'united kingdom',
    us: 'united states',
    usa: 'united states',
    america: 'united states',
    png: 'papua new guinea',
    nz: 'new zealand',
    turkey: 'türkiye',
    turkiye: 'türkiye',
    oz: 'australia',
    antigua: 'antigua and barbuda',
    barbuda: 'antigua and barbuda',
    cooks: 'cook islands',
    rarotonga: 'cook islands',
    ...Object.fromEntries(US_STATES.split(/\s+/).map((s) => [s.replace(/_/g, ' '), 'united states'])),
};

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/* ── Matching ─────────────────────────────────────────────────── */

// Names match as whole words, never as letters inside a word (130-09): the
// old lookup found 'us' in 'Russell, NZ' and 'sa' in 'Santa Cruz'. Text is
// folded to plain lower-case words first: accents and apostrophes dropped,
// anything else that is not a letter or a digit a break between words. So
// 'Noumea' finds 'Nouméa', 'Saint Martin' finds 'Saint-Martin' and 'St Johns'
// finds "St John's".
const FOLD: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ı: 'i' };

function nameWords(text: string): string[] {
    return text
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[øæœßłđı]/g, (c) => FOLD[c] ?? c)
        .replace(/['‘’ʼ]/g, '')
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

interface Phrase {
    words: readonly string[];
    /** Letters and spaces matched: the longest match wins. */
    size: number;
    key: string;
}

const phrase = (text: string, key: string): Phrase => {
    const words = nameWords(text);
    return { words, size: words.join(' ').length, key };
};

/** `words` holds `wanted` as whole words, in order. */
function holdsPhrase(words: readonly string[], wanted: readonly string[]): boolean {
    if (!wanted.length) return false;
    for (let i = 0; i + wanted.length <= words.length; i++) {
        if (wanted.every((w, j) => words[i + j] === w)) return true;
    }
    return false;
}

/** The longest phrase found in `words`; of two the same length, the first. */
function longestIn(words: readonly string[], phrases: readonly Phrase[]): Phrase | undefined {
    let best: Phrase | undefined;
    for (const p of phrases) {
        if ((!best || p.size > best.size) && holdsPhrase(words, p.words)) best = p;
    }
    return best;
}

// Every country's key and name, then the aliases. Keys come first so that
// 'Turkey' finds its own guide record before the alias for Türkiye. Last, the
// places elsewhere, with no key: the longer name wins, so 'Baja California'
// beats 'California'.
const COUNTRY_PHRASES: readonly Phrase[] = [
    ...Object.keys(CUSTOMS_PORT_INDEX).map((k) => phrase(k, k)),
    ...Object.entries(CUSTOMS_PORT_INDEX).map(([k, c]) => phrase(c.country, k)),
    ...Object.entries(COUNTRY_ALIASES)
        .filter(([, k]) => has(CUSTOMS_PORT_INDEX, k))
        .map(([alias, k]) => phrase(alias, k)),
    ...ELSEWHERE.map((name) => phrase(name, '')),
];

// A port of entry by its name or the other name in its brackets: 'Southport'
// for 'Gold Coast (Southport)', 'Tortola' for 'Road Town (Tortola)'. Brackets
// that only say whose side a port is on are not a name: 'Gibraltar (UK)',
// 'Marigot (French)'.
const NOT_A_NAME = new Set(['uk', 'dutch', 'french']);
const PORT_PHRASES: readonly Phrase[] = Object.entries(CUSTOMS_PORT_INDEX).flatMap(([k, c]) =>
    c.portsOfEntry
        .flatMap((port) => port.split(/[()]/).map((part) => phrase(part, k)))
        .filter((p) => p.words.length > 0 && !NOT_A_NAME.has(p.words.join(' '))),
);

// Words that are no place on their own: a lone 'Harbour' or 'Port' is not
// part of some longer port's name.
const NO_PLACE = new Set(
    `port harbour harbor bay town road island isle marina docks grand coast
     st saint de la las los san van new key west`.split(/\s+/),
);

/** The country key of a port of entry named in `words`: a port's whole name
 *  in the text ('Sydney Harbour'), or else the whole text inside a longer
 *  port name ('Coffs' for 'Coffs Harbour', 'Palma' for 'Palma de Mallorca'). */
function portKey(words: readonly string[], ports: readonly Phrase[]): string | undefined {
    const named = longestIn(words, ports);
    if (named) return named.key;
    if (!words.length || words.every((w) => NO_PLACE.has(w))) return undefined;
    return ports.find((p) => holdsPhrase(p.words, words))?.key;
}

// Each country's port-of-entry words: what a port's name may come with and
// still mean that port ('Las Palmas, Canaries').
const PORT_WORDS: Record<string, ReadonlySet<string>> = Object.fromEntries(
    Object.entries(CUSTOMS_PORT_INDEX).map(([k, c]) => [k, new Set(c.portsOfEntry.flatMap(nameWords))]),
);

// Words that say where in a port, not which place ('Sydney Harbour').
const IN_PORT = new Set(['harbour', 'harbor', 'marina', 'docks', 'wharf', 'quay', 'anchorage']);

/**
 * The guide key for a country or port name, or undefined when the index
 * cannot place it. A country's name or an alias in the text comes first
 * ('Opua, NZ'), then a port of entry ('Opua'); of several, the longest
 * ('Marigot Bay' is Saint Lucia, 'Marigot' Sint Maarten). The customs card
 * and isSameCountry both read this, so they agree on the country (130-09).
 * A port's name beside a place the index does not know ('St George's,
 * Bermuda', 'Mare Island') may be another port of that name: unknown.
 */
export function findCountryKey(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const words = nameWords(name);
    const country = longestIn(words, COUNTRY_PHRASES);
    if (country) return country.key || undefined;
    const key = portKey(words, PORT_PHRASES);
    return key && words.every((w) => PORT_WORDS[key].has(w) || IN_PORT.has(w)) ? key : undefined;
}

/** The country a port or country name is in, or '' when the index cannot
 *  place it (an unknown port). */
export function resolveCountryName(portOrCountry: string | undefined): string {
    const key = findCountryKey(portOrCountry);
    return key ? CUSTOMS_PORT_INDEX[key].country : '';
}

/**
 * Whether a port is one of the country's designated ports of entry, matched
 * as findCountryKey matches ports. Only the name before any comma counts:
 * 'Newport' in 'Newport, QLD'.
 */
export function isPortOfEntry(port: string | undefined, key: string | undefined): boolean {
    if (!port || !key) return false;
    const ports = PORT_PHRASES.filter((p) => p.key === key);
    return portKey(nameWords(port.split(',')[0]), ports) !== undefined;
}

/**
 * Whether two ports are in the same country. A missing port never is, nor
 * one the index cannot place, unless it is the same port at both ends (a
 * round trip). Two unknown ports used to count as one country, which hid
 * clearance (130-09); the customs card now says it cannot tell.
 */
export function isSameCountry(portA: string | undefined, portB: string | undefined): boolean {
    if (!portA || !portB) return false;
    const countryA = resolveCountryName(portA);
    if (countryA) return countryA === resolveCountryName(portB);
    const wordsA = nameWords(portA).join(' ');
    return wordsA !== '' && wordsA === nameWords(portB).join(' ');
}

/** Both ports given, and neither one the index can place: the customs card
 *  then has the skipper's one border check, no documents (130-09). */
export function placesNeither(portA: string | null | undefined, portB: string | null | undefined): boolean {
    if (!portA || !portB) return false;
    return !findCountryKey(portA) && !findCountryKey(portB);
}
