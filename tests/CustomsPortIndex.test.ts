/**
 * Customs: a small synchronous port index, and the clearance guide as data
 * (build 126 bundle diet).
 *
 * isSameCountry decides whether a passage needs customs at all, and two
 * screens call it synchronously while they render (CrewManagement's cast-off
 * gate and the readiness card stack). So the part it needs, every country's
 * name and designated ports of entry plus the shorthand aliases, stays in
 * JavaScript as a few KB. The clearance guide itself (procedures, contacts,
 * documents, fees: about 40 KB) moved to public/data/customs-clearance.json
 * and loads when the customs card opens.
 *
 * The fixture first recorded what the OLD module answered, before the split,
 * for every country key, country name, port of entry, alias and a spread of
 * free-text port names from around the world, and the split kept every one
 * of those answers. Package 130-09 changed them on purpose: names now match
 * as whole words, so 'us' is no longer found inside 'Russell' nor 'sa' inside
 * 'Santa Cruz', and two ports the index cannot place are no longer taken to
 * be in one country. The fixture was re-baselined once for that; every
 * answer that changed is in CHANGED_IN_130_09 below, each checked by hand.
 *
 * Re-baseline (only for a change meant to alter answers, listing each one):
 *   REGEN_CUSTOMS_BASELINE=1 npx vitest run tests/CustomsPortIndex.test.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CUSTOMS_PORT_INDEX,
    findCountryKey,
    isPortOfEntry,
    isSameCountry,
    placesNeither,
    resolveCountryName,
} from '../data/customsPortIndex';
import { joinClearance, type CountryClearanceDetails } from '../data/customsDb';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'tests/fixtures/customs-same-country-baseline.json');

interface Baseline {
    source: string;
    countryOrder: string[];
    clearanceSha256: string;
    inputs: string[];
    resolveCountryName: string[];
    findCountryData: (string | null)[];
    isSameCountryHexRows: string[];
}

const bitsOf = (hex: string, n: number) =>
    [...hex]
        .map((h) => parseInt(h, 16).toString(2).padStart(4, '0'))
        .join('')
        .slice(0, n);

const hexOf = (bits: boolean[]) => {
    const padded = bits.map((b) => (b ? '1' : '0')).join('');
    let hex = '';
    for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
    return hex;
};

if (process.env.REGEN_CUSTOMS_BASELINE === '1') {
    const old = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    const next: Baseline = {
        ...old,
        source:
            'The answers of data/customsPortIndex.ts with whole-word matching (130-09), re-baselined on purpose. ' +
            'The inputs, country order and clearance hash are the ones first recorded from data/customsDb.ts at ' +
            'master 058ba16e, before build 126 moved the clearance details to public/data/customs-clearance.json.',
        resolveCountryName: old.inputs.map((s) => resolveCountryName(s)),
        findCountryData: old.inputs.map((s) => findCountryKey(s) ?? null),
        isSameCountryHexRows: old.inputs.map((a) => hexOf(old.inputs.map((b) => isSameCountry(a, b)))),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
const details = JSON.parse(readFileSync(join(ROOT, 'public/data/customs-clearance.json'), 'utf8')) as Record<
    string,
    CountryClearanceDetails
>;

afterEach(() => vi.unstubAllGlobals());

describe('isSameCountry: every recorded port and pair', () => {
    it('is synchronous and needs no file: it answers with every fetch failing', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                throw new Error('isSameCountry must not fetch');
            }),
        );
        const answer = isSameCountry('Falmouth', 'Las Palmas');
        expect(typeof answer).toBe('boolean');
        expect(answer).toBe(false);
        expect(isSameCountry('Opua', 'Auckland')).toBe(true);
    });

    it('resolves every recorded input to the baseline country', () => {
        const n = baseline.inputs.length;
        expect(n).toBeGreaterThan(300);
        const mismatches = baseline.inputs.filter((s, i) => resolveCountryName(s) !== baseline.resolveCountryName[i]);
        expect(mismatches).toEqual([]);
    });

    it('finds the baseline country record for every recorded input', () => {
        const mismatches = baseline.inputs.filter(
            (s, i) => (findCountryKey(s) ?? null) !== baseline.findCountryData[i],
        );
        expect(mismatches).toEqual([]);
    });

    it('gives the baseline answer for every pair of recorded inputs', () => {
        const n = baseline.inputs.length;
        const mismatches: string[] = [];
        baseline.inputs.forEach((a, i) => {
            const row = bitsOf(baseline.isSameCountryHexRows[i], n);
            baseline.inputs.forEach((b, j) => {
                if (isSameCountry(a, b) !== (row[j] === '1')) mismatches.push(`${a} | ${b}`);
            });
        });
        expect(mismatches.slice(0, 20)).toEqual([]);
    });

    it('keeps the empty-port rule: a missing port is never "same country"', () => {
        expect(isSameCountry(undefined, 'Sydney')).toBe(false);
        expect(isSameCountry('Sydney', '')).toBe(false);
        expect(isSameCountry(undefined, undefined)).toBe(false);
    });

    it('the customs card and the cast-off gate agree on every recorded port (130-09)', () => {
        // The card names the country from findCountryKey; isSameCountry reads
        // resolveCountryName. A port of entry on its own ('Sydney') used to
        // have a country for the gate and none for the card.
        const disagree = baseline.inputs.filter((s) => {
            const key = findCountryKey(s);
            return (key ? CUSTOMS_PORT_INDEX[key].country : '') !== resolveCountryName(s);
        });
        expect(disagree).toEqual([]);
        expect(findCountryKey('Sydney')).toBe('australia');
    });
});

describe('130-09: a port matches its own country, worldwide', () => {
    // Each row: what the skipper typed, the country the index now gives ('' is
    // a port it cannot place: the customs card says so rather than guess).
    it.each([
        // 'us' was found inside 'Russell' (United States).
        ['Russell, NZ', 'New Zealand'],
        ['Russell, Bay of Islands, New Zealand', 'New Zealand'],
        // 'sa' was found inside 'Santa' (Australia).
        ['Santa Cruz', ''],
        ['Santa Cruz, Tenerife', ''],
        ['Santa Cruz de Tenerife, Spain', 'Spain'],
        ['Santa Cruz, California', ''],
        ['Santa Cruz, Galápagos', ''],
        ['Puerto Ayora, Santa Cruz, Galápagos', ''],
        // Nouméa, with and without its accent.
        ['Nouméa', 'New Caledonia'],
        ['Noumea', 'New Caledonia'],
        ['Port Moselle, Nouméa', 'New Caledonia'],
        ['Port Moselle, NC', 'New Caledonia'],
        // Two Newports, two countries (no US state is in the index yet).
        ['Newport, QLD', 'Australia'],
        ['Newport, RI', ''],
        ['Newport, Rhode Island, USA', 'United States'],
        // Saint-Martin, however it is written.
        ['Saint-Martin', 'Sint Maarten'],
        ['Saint Martin', 'Sint Maarten'],
        ['Marigot, Saint-Martin', 'Sint Maarten'],
        // The BVI.
        ['BVI', 'British Virgin Islands'],
        ['the BVI', 'British Virgin Islands'],
        ['Nanny Cay, Tortola, BVI', 'British Virgin Islands'],
        ['Road Town', 'British Virgin Islands'],
        // Bermuda and the Caymans are not in the index. Their ports share a
        // name with Grenada's St George's and the Bahamas' George Town, and
        // must not take those countries' documents.
        ["St George's, Bermuda", ''],
        ["St. George's, Bermuda", ''],
        ['George Town, Cayman Islands', ''],
    ])('%s → %s', (port, country) => {
        expect(resolveCountryName(port)).toBe(country);
    });

    it("a port's name beside a place the index does not know is not that port", () => {
        // Each was unknown before 130-09; splitting bracketed port names must
        // not turn them into some other country.
        for (const port of [
            'George Town, Penang', // the Bahamas' 'George Town (Exumas)'
            'Freeport, Texas', // the Bahamas' 'Freeport (Grand Bahama)'
            'New London, CT', // the UK's 'London (St Katharine Docks)'
            'Gold Coast, Ghana', // Australia's 'Gold Coast (Southport)'
            'Mare Island', // New Caledonia's 'Wé (Maré)'
            "St. John's, Newfoundland", // Antigua's "St John's"
            'Las Palmas, Gran Canaria', // Gran Canaria is not a name the index holds
        ]) {
            expect(findCountryKey(port), port).toBeUndefined();
        }
        // Nelson Bay is in New South Wales, not at Nelson, New Zealand.
        expect(resolveCountryName('Nelson Bay')).toBe('');
        expect(resolveCountryName('Nelson Bay, NSW')).toBe('Australia');
        // A port alone, with its other name, or with where in the port, still counts.
        expect(resolveCountryName("St George's")).toBe('Grenada');
        expect(resolveCountryName('George Town')).toBe('Bahamas');
        expect(resolveCountryName('Gold Coast')).toBe('Australia');
        expect(resolveCountryName('Las Palmas, Canaries')).toBe('Spain');
        expect(resolveCountryName('Road Town, Tortola')).toBe('British Virgin Islands');
        expect(resolveCountryName('Horta, Azores')).toBe('Portugal');
        expect(resolveCountryName('Msida Marina, Valletta')).toBe('Malta');
        expect(resolveCountryName('Sydney Harbour')).toBe('Australia');
    });

    it('still finds a short alias that stands as a word of its own', () => {
        expect(resolveCountryName('Adelaide, SA')).toBe('Australia');
        expect(resolveCountryName('Miami, US')).toBe('United States');
        expect(resolveCountryName('Opua, NZ')).toBe('New Zealand');
        expect(resolveCountryName('Falmouth, UK')).toBe('United Kingdom');
    });

    it('never finds a short alias inside a longer word', () => {
        // 'us' in Australia, Cyprus, Piraeus; 'sa' in Nassau, Thessaloniki;
        // 'nt' in Antibes, Montenegro; 'nc' in France, Valencia; 'uk' in Phuket.
        expect(resolveCountryName('Cairns, Australia')).toBe('Australia');
        expect(resolveCountryName('Larnaca, Cyprus')).toBe('Cyprus');
        expect(resolveCountryName('Piraeus (Athens)')).toBe('Greece');
        expect(resolveCountryName('Nassau')).toBe('Bahamas');
        expect(resolveCountryName('Thessaloniki')).toBe('Greece');
        expect(resolveCountryName('Antibes')).toBe('France');
        expect(resolveCountryName('Kotor, Montenegro')).toBe('Montenegro');
        expect(resolveCountryName('Marseille, France')).toBe('France');
        expect(resolveCountryName('Valencia')).toBe('Spain');
        expect(resolveCountryName('Phuket')).toBe('');
    });

    it('takes the longest match first', () => {
        // Saint Lucia's 'Marigot Bay' over Sint Maarten's 'Marigot'.
        expect(resolveCountryName('Marigot Bay')).toBe('Saint Lucia');
        expect(resolveCountryName('Marigot')).toBe('Sint Maarten');
        // A country named in the text before a port's name: 'UK', not Spain's 'Gibraltar'.
        expect(resolveCountryName('Gibraltar (UK)')).toBe('United Kingdom');
        expect(resolveCountryName('Gibraltar')).toBe('Spain');
    });

    it('finds a port of entry by its whole name, or by the part a skipper says', () => {
        expect(resolveCountryName('Sydney Harbour')).toBe('Australia');
        expect(resolveCountryName('Southport')).toBe('Australia');
        expect(resolveCountryName('Coffs')).toBe('Australia');
        expect(resolveCountryName('Palma')).toBe('Spain');
        expect(resolveCountryName('Las Palmas')).toBe('Spain');
        expect(resolveCountryName('Kusadasi')).toBe('Türkiye');
        // A port's name is a whole word: France's 'Nice' is not inside 'Venice'.
        expect(resolveCountryName('Venice')).toBe('Italy');
        // A word that is no place on its own is not a port.
        for (const word of ['Harbour', 'Bay', 'Port', 'St', 'a']) expect(resolveCountryName(word)).toBe('');
    });

    it('a fragment of a country name is not the country', () => {
        expect(findCountryKey('new zeal')).toBeUndefined();
        expect(findCountryKey('Wales')).toBeUndefined();
    });

    it('two ports the index cannot place are not one country, unless they are the same port', () => {
        expect(isSameCountry('Santa Cruz, California', 'Santa Cruz, Galápagos')).toBe(false);
        expect(isSameCountry('Phuket', 'Langkawi')).toBe(false);
        expect(isSameCountry('Newport, RI', 'Newport, QLD')).toBe(false);
        // A round trip from a port the index does not know.
        expect(isSameCountry('Mooloolaba', 'Mooloolaba')).toBe(true);
        expect(isSameCountry('Santa Cruz, Galápagos', 'santa cruz galapagos')).toBe(true);
        // Every recorded pair of two different unknown ports.
        const unknown = baseline.inputs.filter((s) => resolveCountryName(s) === '');
        expect(unknown.length).toBeGreaterThan(10);
        const sameAnyway = unknown.flatMap((a) =>
            unknown.filter((b) => a.trim() !== b.trim() && isSameCountry(a, b)).map((b) => `${a} | ${b}`),
        );
        expect(sameAnyway).toEqual([]);
    });

    it('pairs across the world', () => {
        expect(isSameCountry('Russell, NZ', 'Opua')).toBe(true);
        expect(isSameCountry('Russell, NZ', 'Miami')).toBe(false);
        expect(isSameCountry('Nouméa', 'Port Moselle, NC')).toBe(true);
        expect(isSameCountry('Newport, QLD', 'Port Moselle, NC')).toBe(false);
        expect(isSameCountry('Saint-Martin', 'Philipsburg')).toBe(true);
        expect(isSameCountry('Road Town, BVI', 'Tortola')).toBe(true);
        expect(isSameCountry('Santa Cruz de Tenerife, Spain', 'Las Palmas')).toBe(true);
    });

    it('the Bermuda run: neither port placed, so the card has a border check, never Grenada', () => {
        expect(isSameCountry('Newport, RI', "St George's, Bermuda")).toBe(false);
        expect(placesNeither('Newport, RI', "St George's, Bermuda")).toBe(true);
        expect(isPortOfEntry("St George's, Bermuda", findCountryKey("St George's, Bermuda"))).toBe(false);
        // Bermuda to Horta: the Azores end is placed, so its documents are listed.
        expect(isSameCountry("St George's, Bermuda", 'Horta, Azores')).toBe(false);
        expect(placesNeither("St George's, Bermuda", 'Horta, Azores')).toBe(false);
        // A port the index can place on either end, or a missing one, is not "neither".
        expect(placesNeither('Russell, NZ', 'Phuket')).toBe(false);
        expect(placesNeither('Phuket', undefined)).toBe(false);
        expect(placesNeither(null, 'Phuket')).toBe(false);
    });

    it('checks a port of entry by whole words, accents folded', () => {
        expect(isPortOfEntry('Port Moselle, NC', 'new caledonia')).toBe(true);
        expect(isPortOfEntry('Noumea', 'new caledonia')).toBe(true);
        expect(isPortOfEntry('Southport, QLD', 'australia')).toBe(true);
        expect(isPortOfEntry('Coffs', 'australia')).toBe(true);
        expect(isPortOfEntry('Newport, QLD', 'australia')).toBe(false);
        expect(isPortOfEntry('Whangaroa, NZ', 'new zealand')).toBe(false);
        expect(isPortOfEntry('Venice', 'france')).toBe(false);
        expect(isPortOfEntry('Harbour', 'malta')).toBe(false);
        expect(isPortOfEntry('Sydney', undefined)).toBe(false);
    });
});

describe('130-09: every recorded answer that changed, checked', () => {
    // [input, the old answer, the answer now]. The old lookup found aliases
    // and names as letters anywhere: 'us', 'sa', 'nt', 'nc', 'uk', 'oz' inside
    // other words, and a lone word inside a longer name ('Bar' in 'Barbuda',
    // 'Tonga' in 'Rarotonga', 'Port' in 'Portugal').
    const CHANGED_IN_130_09: [string, string, string][] = [
        ['Cairns, Australia', 'United States', 'Australia'], // 'us' in Australia
        ['Brisbane, Australia', 'United States', 'Australia'],
        ['Sabang', 'Australia', 'Indonesia'], // 'sa'
        ['Sabang, Indonesia', 'Australia', 'Indonesia'],
        ['Levuka', 'United Kingdom', 'Fiji'], // 'uk'
        ['Savusavu', 'Australia', 'Fiji'],
        ['San Diego', 'Australia', 'United States'], // 'sa' in San
        ['San Francisco', 'Australia', 'United States'],
        ['San Diego, United States', 'Australia', 'United States'],
        ['Fort Lauderdale, USA', 'Australia', 'United States'], // 'sa' in USA
        ['Luganville (Santo)', 'Australia', 'Vanuatu'],
        ['Nuku Hiva (Marquesas)', 'Australia', 'French Polynesia'],
        ['Papeete (Tahiti), French Polynesia', 'New Caledonia', 'French Polynesia'], // 'nc' in French
        ['Antibes', 'Australia', 'France'], // 'nt'
        ['Marseille, France', 'New Caledonia', 'France'],
        ['Cherbourg, France', 'New Caledonia', 'France'],
        ['Edinburgh (Granton)', 'Australia', 'United Kingdom'],
        ['Antalya', 'Australia', 'Türkiye'],
        ['Kas', '', 'Türkiye'], // Kaş, accent folded
        ['izmir', '', 'Türkiye'], // İzmir, accent folded
        ['Piraeus (Athens)', 'United States', 'Greece'],
        ['Piraeus (Athens), Greece', 'United States', 'Greece'],
        ['Thessaloniki', 'Australia', 'Greece'],
        ['Zakynthos', 'Australia', 'Greece'],
        ['Cagliari (Sardinia)', 'Australia', 'Italy'],
        ['Venice', 'France', 'Italy'], // 'Nice' in Venice
        ['Valencia', 'New Caledonia', 'Spain'],
        ['Alicante', 'Australia', 'Spain'],
        ['Bar', 'Antigua and Barbuda', 'Montenegro'], // Bar is Montenegro's port
        ['Kotor, Montenegro', 'Australia', 'Montenegro'],
        ['Gozo (Mġarr)', 'Australia', 'Malta'], // 'oz'
        ['Larnaca, Cyprus', 'United States', 'Cyprus'],
        ['Funchal (Madeira)', 'New Caledonia', 'Portugal'],
        ['English Harbour, Antigua and Barbuda', 'Australia', 'Antigua and Barbuda'],
        ['Rodney Bay, Saint Lucia', 'Australia', 'Saint Lucia'],
        ['Marigot (French)', 'New Caledonia', 'Sint Maarten'],
        ['Simpson Bay (Dutch), Sint Maarten', 'Australia', 'Sint Maarten'],
        ['Nassau', 'Australia', 'Bahamas'],
        ['Nassau, Bahamas', 'Australia', 'Bahamas'],
        // Not in the index: now unknown, not some other country.
        ['Phuket', 'United Kingdom', ''],
        ["Nuku'alofa", 'United Kingdom', ''],
        ['Tonga', 'Cook Islands', ''],
        ['Samoa', 'Australia', ''],
        ['Harbour', 'Australia', ''],
        ['Bay', 'Saint Lucia', ''],
        ['Port', 'Portugal', ''],
        ['St', 'Australia', ''],
        ['a', 'Australia', ''],
    ];

    it.each(CHANGED_IN_130_09)('%s: was "%s", now "%s"', (input, was, now) => {
        expect(was).not.toBe(now);
        expect(resolveCountryName(input)).toBe(now);
        expect(baseline.resolveCountryName[baseline.inputs.indexOf(input)]).toBe(now);
    });

    it('lists only recorded inputs', () => {
        expect(CHANGED_IN_130_09.filter(([input]) => !baseline.inputs.includes(input))).toEqual([]);
    });
});

describe('the index and the clearance guide split the old data without loss', () => {
    it('covers the same countries in the same order', () => {
        expect(Object.keys(CUSTOMS_PORT_INDEX)).toEqual(baseline.countryOrder);
        expect(Object.keys(details)).toEqual(baseline.countryOrder);
    });

    it('joins back into exactly the old clearance records', () => {
        const canonical = (v: unknown): unknown =>
            Array.isArray(v)
                ? v.map(canonical)
                : v && typeof v === 'object'
                  ? Object.fromEntries(
                        Object.keys(v as object)
                            .sort()
                            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
                    )
                  : v;
        const joined = joinClearance(details);
        const sha = createHash('sha256')
            .update(JSON.stringify(canonical(joined)))
            .digest('hex');
        expect(sha).toBe(baseline.clearanceSha256);
    });

    it('keeps the clearance prose out of the synchronous module', () => {
        const index = readFileSync(join(ROOT, 'data/customsPortIndex.ts'), 'utf8');
        expect(index.length).toBeLessThan(16_000);
        expect(index).not.toMatch(/departureProcedure|arrivalProcedure|requiredDocuments/);
        const db = readFileSync(join(ROOT, 'data/customsDb.ts'), 'utf8');
        expect(db.length).toBeLessThan(16_000);
        expect(db).not.toContain('Maritime Arrivals Reporting System');
    });

    it('holds no country name or port list twice: those live in the index only', () => {
        for (const record of Object.values(details)) {
            expect(record).not.toHaveProperty('country');
            expect(record).not.toHaveProperty('portsOfEntry');
            expect(record).not.toHaveProperty('flag');
        }
    });
});
