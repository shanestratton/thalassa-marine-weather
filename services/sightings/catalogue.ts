/**
 * The Sightings species catalogue: about 170 Queensland and Great Barrier
 * Reef species in eight groups, common and scientific names, and a
 * `sensitive` flag for threatened species (EPBC, Queensland NCA or IUCN
 * CR/EN/VU; when unsure, true).
 *
 * It ships as a JSON ASSET in dist (data/sightings/species-qld-gbr.v1.json),
 * not as JavaScript and not from the internet: in the iOS app it is a local
 * file, so the picker works at sea. The same list seeds public.sighting_taxa
 * in migration 20261005150000; tests/sightings/SightingsCatalogue.test.ts
 * keeps the two identical, because the server copies names from its table
 * and decides public fuzzing from its own `sensitive` flag.
 *
 * No images: each group draws its own SVG glyph.
 */
import { isSightingGroup, SIGHTING_GROUPS, type SightingGroup } from './types';

export interface CatalogueSpecies {
    id: string;
    group: SightingGroup;
    vernacularName: string;
    scientificName: string;
    taxonRank: string;
    family: string | null;
    class: string | null;
    sensitive: boolean;
    status: string | null;
    aka: string[];
    /** Status recalled, not re-checked; to verify against SPRAT / the IUCN Red List. */
    verifyStatus: boolean;
}

export interface CatalogueGroup {
    id: SightingGroup;
    label: string;
    /** The taxon Darwin Core carries for a group-only sighting. */
    placeholder: { scientific: string; rank: string };
    /** Group-only rows of a sensitive group are generalised to the coarse grid (every group, since 2026-10-05). */
    sensitive: boolean;
    distanceCard: 'whale' | 'dolphin' | null;
    neverPublic: boolean;
}

export interface SightingCatalogue {
    version: number;
    groups: CatalogueGroup[];
    likelyFirst: Record<SightingGroup, string[]>;
    species: CatalogueSpecies[];
    byScientificName: ReadonlyMap<string, CatalogueSpecies>;
}

/**
 * Group-level facts the app needs before (or without) the catalogue file:
 * the placeholder taxon for Darwin Core and whether a group-only public row
 * is coarse. Equal to the JSON's groups (a test checks) and to the server's
 * rule in get_public_sightings.
 */
export const GROUP_PLACEHOLDERS: Record<SightingGroup, { scientific: string; rank: string }> = {
    whale: { scientific: 'Cetacea', rank: 'infraorder' },
    dolphin: { scientific: 'Delphinidae', rank: 'family' },
    dugong: { scientific: 'Dugong dugon', rank: 'species' },
    turtle: { scientific: 'Chelonioidea', rank: 'superfamily' },
    seabird: { scientific: 'Aves', rank: 'class' },
    shark_ray: { scientific: 'Elasmobranchii', rank: 'subclass' },
    fish: { scientific: 'Actinopterygii', rank: 'class' },
    other: { scientific: 'Animalia', rank: 'kingdom' },
};

/**
 * Groups whose group-only public rows go on the coarse grid (server:
 * get_public_sightings): all of them. A group is refined to a species later,
 * and a public copy that was 1 km while it said "Seabird" would pin down a
 * little tern once it was named.
 */
export const COARSE_GROUPS: ReadonlySet<SightingGroup> = new Set<SightingGroup>(SIGHTING_GROUPS);

/** Fine and coarse public grids, in degrees and the uncertainty the server reports for each. */
export const PUBLIC_GRID = {
    fine: { degrees: 0.01, uncertaintyM: 790 },
    coarse: { degrees: 0.1, uncertaintyM: 7850 },
} as const;

function str(value: unknown, field: string, max = 200): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new Error(`Sightings catalogue: bad ${field}`);
    }
    return value;
}

function optionalStr(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

/** Validate the catalogue JSON. Throws on anything malformed: a half-read list is worse than none. */
export function parseCatalogue(raw: unknown): SightingCatalogue {
    if (!raw || typeof raw !== 'object') throw new Error('Sightings catalogue: not an object');
    const doc = raw as Record<string, unknown>;
    if (doc.schema !== 'thalassa.sightings.catalogue') throw new Error('Sightings catalogue: wrong schema');
    const version = typeof doc.version === 'number' ? doc.version : NaN;
    if (version !== 1) throw new Error('Sightings catalogue: unknown version');

    if (!Array.isArray(doc.groups)) throw new Error('Sightings catalogue: no groups');
    const groups: CatalogueGroup[] = doc.groups.map((g) => {
        const group = g as Record<string, unknown>;
        if (!isSightingGroup(group.id)) throw new Error('Sightings catalogue: bad group id');
        const placeholder = group.placeholder as Record<string, unknown> | undefined;
        return {
            id: group.id,
            label: str(group.label, 'group label', 40),
            placeholder: {
                scientific: str(placeholder?.scientific, 'placeholder'),
                rank: str(placeholder?.rank, 'placeholder rank', 30),
            },
            sensitive: group.sensitive === true,
            distanceCard:
                group.distanceCard === 'whale' || group.distanceCard === 'dolphin' ? group.distanceCard : null,
            neverPublic: group.neverPublic === true,
        };
    });
    if (groups.length !== SIGHTING_GROUPS.length || new Set(groups.map((g) => g.id)).size !== SIGHTING_GROUPS.length) {
        throw new Error('Sightings catalogue: groups must be the eight sightings groups');
    }

    if (!Array.isArray(doc.species)) throw new Error('Sightings catalogue: no species');
    const byScientificName = new Map<string, CatalogueSpecies>();
    const species: CatalogueSpecies[] = doc.species.map((s) => {
        const row = s as Record<string, unknown>;
        if (!isSightingGroup(row.group)) throw new Error('Sightings catalogue: bad species group');
        if (typeof row.sensitive !== 'boolean') throw new Error('Sightings catalogue: sensitive must be a boolean');
        const entry: CatalogueSpecies = {
            id: str(row.id, 'species id', 120),
            group: row.group,
            vernacularName: str(row.vernacularName, 'vernacular name', 120),
            scientificName: str(row.scientificName, 'scientific name', 120),
            taxonRank: str(row.taxonRank, 'rank', 30),
            family: optionalStr(row.family),
            class: optionalStr(row.class),
            sensitive: row.sensitive,
            status: optionalStr(row.status),
            aka: Array.isArray(row.aka) ? row.aka.filter((a): a is string => typeof a === 'string' && !!a.trim()) : [],
            verifyStatus: row.verifyStatus === true,
        };
        if (byScientificName.has(entry.scientificName)) {
            throw new Error(`Sightings catalogue: duplicate ${entry.scientificName}`);
        }
        byScientificName.set(entry.scientificName, entry);
        return entry;
    });

    const rawLikely = (doc.likelyFirst ?? {}) as Record<string, unknown>;
    const likelyFirst = {} as Record<SightingGroup, string[]>;
    for (const group of SIGHTING_GROUPS) {
        const names = Array.isArray(rawLikely[group]) ? (rawLikely[group] as unknown[]) : [];
        likelyFirst[group] = names.filter(
            (name): name is string => typeof name === 'string' && byScientificName.get(name)?.group === group,
        );
    }

    return { version, groups, likelyFirst, species, byScientificName };
}

/**
 * Where the bundled file is. Vite rewrites this to the hashed asset in dist;
 * in the iOS app that is a local file, so it loads offline.
 */
export const CATALOGUE_URL = new URL('../../data/sightings/species-qld-gbr.v1.json', import.meta.url).href;

let cached: Promise<SightingCatalogue | null> | null = null;

/** Load (once) and validate the bundled catalogue. Null if it cannot be read; group logging still works. */
export function loadCatalogue(fetcher: typeof fetch = fetch): Promise<SightingCatalogue | null> {
    if (cached) return cached;
    cached = (async () => {
        try {
            const res = await fetcher(CATALOGUE_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseCatalogue(await res.json());
        } catch {
            cached = null; // let a later open try again
            return null;
        }
    })();
    return cached;
}

/** Test seam: forget the cached catalogue. */
export function resetCatalogueCache(): void {
    cached = null;
}

/** Lower case, no accents, apostrophes or hyphens: "Bryde's" finds "brydes", "grey-nurse" finds "grey nurse". */
export function normaliseName(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/[-_/(),.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Search common names, other names and scientific names across every group
 * (a tap on "Whale" may have been a whale shark). Best match first: a whole
 * name, then a name starting with the query, then a word starting with it,
 * then anywhere; the given group breaks ties.
 */
export function searchSpecies(
    catalogue: SightingCatalogue,
    query: string,
    { group, limit = 40 }: { group?: SightingGroup | null; limit?: number } = {},
): CatalogueSpecies[] {
    const q = normaliseName(query);
    if (!q) {
        return catalogue.species.filter((s) => !group || s.group === group).slice(0, limit);
    }
    const scored: Array<{ species: CatalogueSpecies; score: number; index: number }> = [];
    catalogue.species.forEach((species, index) => {
        const names = [species.vernacularName, ...species.aka, species.scientificName].map(normaliseName);
        let best = 0;
        for (const name of names) {
            let score = 0;
            if (name === q) score = 4;
            else if (name.startsWith(q)) score = 3;
            else if (name.split(' ').some((word) => word.startsWith(q))) score = 2;
            else if (name.includes(q)) score = 1;
            if (score > best) best = score;
        }
        if (best > 0) scored.push({ species, score: best + (group && species.group === group ? 0.5 : 0), index });
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, limit).map((s) => s.species);
}

/** The quick chips for a group, in the catalogue's order. */
export function likelyFirst(catalogue: SightingCatalogue, group: SightingGroup): CatalogueSpecies[] {
    return catalogue.likelyFirst[group]
        .map((name) => catalogue.byScientificName.get(name))
        .filter((s): s is CatalogueSpecies => !!s);
}

/**
 * Would a public row of this go on the coarse grid? Mirrors the server
 * (get_public_sightings): once named as threatened always (ever_sensitive),
 * a named species by its own flag (unknown = coarse), a group-only row by its
 * group (every group). For the explainer only; the server decides.
 */
export function isCoarsePublic(
    catalogue: SightingCatalogue | null,
    group: SightingGroup,
    scientificName: string | null,
    everSensitive = false,
): boolean {
    if (everSensitive) return true;
    if (scientificName) return catalogue?.byScientificName.get(scientificName)?.sensitive ?? true;
    return COARSE_GROUPS.has(group);
}
