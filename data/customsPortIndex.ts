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
 * way to take about 40 KB of prose out of the JavaScript; the answers did not
 * change (tests/CustomsPortIndex.test.ts checks every recorded port and pair
 * against the old module). A country needs an entry here AND in the JSON,
 * under the same key, in the same order.
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

// Common name aliases so free-text country and port names from passage plans
// match our keys.
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
    // Australian states (so 'Newport, QLD' resolves to Australia).
    // Without these, the customs card falls through to the
    // 'both ports unknown → assume domestic' branch in isSameCountry,
    // which silently hides international clearance even on legit
    // departures like 'Newport, QLD' → 'Port Moselle, NC'.
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
};

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/**
 * The guide key for a country or port name, or undefined. Direct key, then
 * alias, then partial alias, then partial country name: the lookup the old
 * findCountryData made, now returning the key so the card can find the
 * record in the loaded guide.
 */
export function findCountryKey(country: string | undefined): string | undefined {
    if (!country) return undefined;
    const key = country.toLowerCase().trim();
    // Direct key match
    if (has(CUSTOMS_PORT_INDEX, key)) return key;
    // Alias match
    if (has(COUNTRY_ALIASES, key) && has(CUSTOMS_PORT_INDEX, COUNTRY_ALIASES[key])) return COUNTRY_ALIASES[key];
    // Partial alias match
    const aliasKey = Object.keys(COUNTRY_ALIASES).find((a) => key.includes(a) || a.includes(key));
    if (aliasKey && has(CUSTOMS_PORT_INDEX, COUNTRY_ALIASES[aliasKey])) return COUNTRY_ALIASES[aliasKey];
    // Partial country name match
    return Object.keys(CUSTOMS_PORT_INDEX).find((k) => {
        const name = CUSTOMS_PORT_INDEX[k].country.toLowerCase();
        return name.includes(key) || key.includes(name);
    });
}

/**
 * Resolve a port/city/country name to its canonical country name.
 * Uses a 4-tier lookup:
 *  1. Direct country match via findCountryKey
 *  2. Port-of-entry match (checks all countries' portsOfEntry lists)
 *  3. Substring match (e.g., "Cairns, Australia" → contains "Australia")
 *  4. Returns empty string if not found (unknown port)
 */
export function resolveCountryName(portOrCountry: string | undefined): string {
    if (!portOrCountry) return '';
    const input = portOrCountry.trim();
    const inputLower = input.toLowerCase();

    // 1. Direct country match
    const directKey = findCountryKey(input);
    if (directKey) return CUSTOMS_PORT_INDEX[directKey].country;

    // 2. Check all portsOfEntry across all countries
    for (const entry of Object.values(CUSTOMS_PORT_INDEX)) {
        for (const port of entry.portsOfEntry) {
            const portLower = port.toLowerCase();
            // Match "Sydney" against "Sydney" or "Cairns" against "Cairns"
            // Also match partial: "Road Town" in "Road Town (Tortola)"
            if (inputLower === portLower || portLower.includes(inputLower) || inputLower.includes(portLower)) {
                return entry.country;
            }
        }
    }

    // 3. Check if the input contains a country name (e.g., "Cairns, Australia")
    for (const entry of Object.values(CUSTOMS_PORT_INDEX)) {
        if (inputLower.includes(entry.country.toLowerCase())) {
            return entry.country;
        }
    }
    // Also check aliases
    for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
        if (inputLower.includes(alias) && has(CUSTOMS_PORT_INDEX, target)) {
            return CUSTOMS_PORT_INDEX[target].country;
        }
    }

    // 4. Not found — return empty string (unknown port)
    return '';
}

/**
 * Check if two ports/countries are in the same country.
 * If BOTH ports are unknown (not in our DB), we treat them as domestic
 * since we can't determine they're international.
 */
export function isSameCountry(portA: string | undefined, portB: string | undefined): boolean {
    if (!portA || !portB) return false;
    const countryA = resolveCountryName(portA);
    const countryB = resolveCountryName(portB);

    // Both unknown → treat as domestic (same country, just not in our DB)
    if (!countryA && !countryB) return true;

    // One known, one unknown → assume international (different countries)
    if (!countryA || !countryB) return false;

    // Both known → compare
    return countryA.toLowerCase() === countryB.toLowerCase();
}
