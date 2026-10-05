/**
 * The Sightings species catalogue (data/sightings/species-qld-gbr.v1.json)
 * and the server's copy of it (sighting_taxa, seeded in migration
 * 20261005150000). The server copies names from its table and decides public
 * fuzzing from its own `sensitive` flag, so the two must never drift.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    COARSE_GROUPS,
    GROUP_PLACEHOLDERS,
    isCoarsePublic,
    likelyFirst,
    loadCatalogue,
    normaliseName,
    parseCatalogue,
    resetCatalogueCache,
    searchSpecies,
} from '../../services/sightings/catalogue';
import { SIGHTING_GROUPS } from '../../services/sightings/types';

const raw = JSON.parse(readFileSync('data/sightings/species-qld-gbr.v1.json', 'utf8'));
const catalogue = parseCatalogue(raw);
const sql = readFileSync('supabase/migrations/20261005150000_sightings.sql', 'utf8');

/** The VALUES tuples of the sighting_taxa seed, parsed as SQL literals. */
function seedRows(): Array<Array<string | boolean | null>> {
    const seed = sql.slice(sql.indexOf('-- SEED:BEGIN'), sql.indexOf('-- SEED:END'));
    const values = seed.slice(seed.indexOf('VALUES') + 'VALUES'.length, seed.indexOf('ON CONFLICT'));
    const rows: Array<Array<string | boolean | null>> = [];
    const tuple = /\(((?:'(?:[^']|'')*'|NULL|true|false|,|\s)+)\)/g;
    for (const match of values.matchAll(tuple)) {
        const fields: Array<string | boolean | null> = [];
        for (const field of match[1].matchAll(/'((?:[^']|'')*)'|NULL|true|false/g)) {
            if (field[1] !== undefined) fields.push(field[1].replace(/''/g, "'"));
            else if (field[0] === 'NULL') fields.push(null);
            else fields.push(field[0] === 'true');
        }
        rows.push(fields);
    }
    return rows;
}

describe('the species catalogue', () => {
    it('holds at least 150 species in the eight groups, every name unique', () => {
        expect(catalogue.species.length).toBeGreaterThanOrEqual(150);
        expect(catalogue.groups.map((g) => g.id).sort()).toEqual([...SIGHTING_GROUPS].sort());
        for (const group of SIGHTING_GROUPS) {
            expect(
                catalogue.species.some((s) => s.group === group),
                group,
            ).toBe(true);
        }
        const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase())).size;
        expect(lower(catalogue.species.map((s) => s.scientificName))).toBe(catalogue.species.length);
        expect(lower(catalogue.species.map((s) => s.vernacularName))).toBe(catalogue.species.length);
        expect(new Set(catalogue.species.map((s) => s.id)).size).toBe(catalogue.species.length);
    });

    it('gives every threatened species a status, and flags the big ones', () => {
        for (const s of catalogue.species.filter((x) => x.sensitive)) {
            expect(s.status, s.scientificName).toBeTruthy();
        }
        const flag = (name: string) => catalogue.byScientificName.get(name)?.sensitive;
        expect(flag('Dugong dugon')).toBe(true);
        expect(flag('Chelonia mydas')).toBe(true);
        expect(flag('Rhincodon typus')).toBe(true);
        expect(flag('Carcharias taurus')).toBe(true);
        // Humpbacks came off the threatened list in 2022: fine grid.
        expect(flag('Megaptera novaeangliae')).toBe(false);
    });

    it('treats a status still to verify as threatened until it is checked ("when unsure, true")', () => {
        const unsure = catalogue.species.filter((s) => s.verifyStatus);
        expect(unsure.length).toBeGreaterThan(0);
        for (const s of unsure) expect(s.sensitive, s.scientificName).toBe(true);
        expect(catalogue.byScientificName.get('Ardenna carneipes')?.sensitive).toBe(true);
    });

    it('has four quick chips per group (one for dugong), each in its own group', () => {
        for (const group of SIGHTING_GROUPS) {
            const chips = likelyFirst(catalogue, group);
            expect(chips.length, group).toBe(group === 'dugong' ? 1 : 4);
            for (const chip of chips) expect(chip.group).toBe(group);
        }
    });

    it('carries no images or links to them', () => {
        expect(JSON.stringify(raw)).not.toMatch(/\.(jpe?g|png|webp|gif)\b|https?:\/\/[^"]*\/(media|images?)\//i);
    });

    it("keeps the group facts the app uses before the file loads equal to the file's", () => {
        for (const group of catalogue.groups) {
            expect(GROUP_PLACEHOLDERS[group.id], group.id).toEqual(group.placeholder);
            expect(COARSE_GROUPS.has(group.id), group.id).toBe(group.sensitive);
        }
        expect(catalogue.groups.find((g) => g.id === 'fish')?.neverPublic).toBe(true);
        expect(catalogue.groups.find((g) => g.id === 'whale')?.distanceCard).toBe('whale');
        expect(catalogue.groups.find((g) => g.id === 'dolphin')?.distanceCard).toBe('dolphin');
    });

    it('rejects a malformed file instead of half-reading it', () => {
        expect(() => parseCatalogue({ ...raw, schema: 'other' })).toThrow();
        expect(() => parseCatalogue({ ...raw, species: [...raw.species, raw.species[0]] })).toThrow(/duplicate/);
        expect(() =>
            parseCatalogue({ ...raw, species: [{ ...raw.species[0], sensitive: 'yes' }, ...raw.species.slice(1)] }),
        ).toThrow();
    });
});

describe('the server seed equals the catalogue', () => {
    it('seeds exactly the catalogue: name, group, common name, rank, family, class, sensitive, status', () => {
        const rows = seedRows();
        expect(rows).toHaveLength(catalogue.species.length);
        const expected = catalogue.species.map((s) => [
            s.scientificName,
            s.group,
            s.vernacularName,
            s.taxonRank,
            s.family,
            s.class,
            s.sensitive,
            s.status,
        ]);
        expect(rows).toEqual(expected);
    });

    it('coarsens every group-only row on the server, as the app explains', () => {
        expect(sql).toContain(
            '(s.scientific_name IS NULL OR s.ever_sensitive OR COALESCE(t.sensitive, true)) AS c_coarse',
        );
        expect([...COARSE_GROUPS].sort()).toEqual([...SIGHTING_GROUPS].sort());
    });
});

describe('searching and loading', () => {
    it('finds by common name, other name and scientific name, across groups', () => {
        expect(searchSpecies(catalogue, 'humpback')[0].scientificName).toBe('Megaptera novaeangliae');
        expect(searchSpecies(catalogue, 'migaloo')[0].scientificName).toBe('Megaptera novaeangliae');
        expect(searchSpecies(catalogue, 'Dugong dugon')[0].scientificName).toBe('Dugong dugon');
        expect(searchSpecies(catalogue, 'brydes')[0].vernacularName).toBe("Bryde's whale");
        // A "whale" tap that was a whale shark: the shark is still found.
        expect(searchSpecies(catalogue, 'whale shark', { group: 'whale' })[0].scientificName).toBe('Rhincodon typus');
        expect(searchSpecies(catalogue, 'zzzz')).toEqual([]);
        expect(normaliseName("  Bryde's-Whale ")).toBe('brydes whale');
    });

    it('says which public rows go on the coarse grid, as the server does', () => {
        expect(isCoarsePublic(catalogue, 'whale', 'Megaptera novaeangliae')).toBe(false);
        expect(isCoarsePublic(catalogue, 'turtle', 'Chelonia mydas')).toBe(true);
        // Every group-only row is coarse: naming the species later never makes
        // an earlier public copy finer than the one it replaces.
        expect(isCoarsePublic(catalogue, 'dolphin', null)).toBe(true);
        expect(isCoarsePublic(catalogue, 'seabird', null)).toBe(true);
        expect(isCoarsePublic(catalogue, 'whale', null)).toBe(true);
        // Once named as threatened, always coarse (the server's ever_sensitive).
        expect(isCoarsePublic(catalogue, 'whale', 'Megaptera novaeangliae', true)).toBe(true);
        // Not in the catalogue: coarse, like the server's COALESCE(sensitive, true).
        expect(isCoarsePublic(catalogue, 'other', 'Unknownia mysteriosa')).toBe(true);
        expect(isCoarsePublic(null, 'whale', 'Megaptera novaeangliae')).toBe(true);
    });

    it('loads the bundled file once, and returns null (not a throw) when it cannot', async () => {
        resetCatalogueCache();
        const ok = vi.fn(async (_url: string) => new Response(JSON.stringify(raw), { status: 200 }));
        const first = await loadCatalogue(ok as unknown as typeof fetch);
        const second = await loadCatalogue(ok as unknown as typeof fetch);
        expect(first?.species.length).toBe(catalogue.species.length);
        expect(second).toBe(first);
        expect(ok).toHaveBeenCalledTimes(1);
        expect(String(ok.mock.calls[0]?.[0] ?? '')).toMatch(/species-qld-gbr\.v1\.json$/);

        resetCatalogueCache();
        const broken = vi.fn(async (_url: string) => new Response('nope', { status: 404 }));
        await expect(loadCatalogue(broken as unknown as typeof fetch)).resolves.toBeNull();
        resetCatalogueCache();
    });
});
