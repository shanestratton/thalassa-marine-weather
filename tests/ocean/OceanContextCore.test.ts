// @vitest-environment node
/**
 * The historical context layer's rules (scripts/ocean/contextCore.mjs) and
 * the committed file they built (public/ocean-data/context/au-east.v1.json):
 * licence-clean only, no tags or receivers, no absences, no nesting census,
 * record-days, honest months, coarse cells for threatened species, and the
 * antimeridian respected.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    aggregateSpecies,
    cellCentre,
    cellDegFor,
    dropReason,
    fillCitation,
    isExcludedDataset,
    keepRecord,
    LICENCE_URLS,
    licenceOf,
    monthOf,
} from '../../scripts/ocean/contextCore.mjs';

const DAY = 86_400_000;
const t = (iso: string) => Date.parse(iso);
const rec = (over: Record<string, unknown> = {}) => ({
    basisOfRecord: 'HumanObservation',
    absence: false,
    decimalLatitude: -27.1,
    decimalLongitude: 153.6,
    date_start: t('2020-07-15T00:00:00Z'),
    date_end: t('2020-07-15T00:00:00Z'),
    ...over,
});

describe('licences', () => {
    it('accepts exactly the CC BY 4.0 and CC0 1.0 texts OBIS publishes', () => {
        expect(licenceOf('This work is licensed under a  Creative Commons Attribution (CC-BY) 4.0 License')).toBe(
            'CC BY 4.0',
        );
        expect(licenceOf('This work is licensed under a  Creative Commons Attribution (CC-BY 4.0) License')).toBe(
            'CC BY 4.0',
        );
        expect(
            licenceOf(
                'To the extent possible under law, the publisher has waived all rights to these data and has dedicated them to the                  Public Domain (CC0 1.0)',
            ),
        ).toBe('CC0 1.0');
    });

    it('refuses non-commercial, no-derivatives, share-alike, blank and unknown wordings', () => {
        for (const text of [
            'This work is licensed under a  Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0 License',
            'This work is licensed under a  Creative Commons Attribution Non Commercial (CC-BY-NC 4.0) License',
            'This work is licensed under a Creative Commons Attribution-NoDerivatives (CC-BY-ND) 4.0 License',
            'This work is licensed under a Creative Commons Attribution-ShareAlike (CC-BY-SA) 4.0 License',
            'CC-BY',
            '',
            null,
        ]) {
            expect(licenceOf(text)).toBeNull();
        }
    });
});

describe('records', () => {
    it('drops tags and receivers, absences, undated and impossible records', () => {
        expect(keepRecord(rec())).toBe(true);
        expect(keepRecord(rec({ basisOfRecord: 'PreservedSpecimen' }))).toBe(true);
        expect(keepRecord(rec({ basisOfRecord: 'MachineObservation' }))).toBe(false);
        expect(keepRecord(rec({ basisOfRecord: 'machineObservation' }))).toBe(false);
        expect(keepRecord(rec({ absence: true }))).toBe(false);
        expect(keepRecord(rec({ date_start: undefined }))).toBe(false);
        expect(keepRecord(rec({ decimalLatitude: 95 }))).toBe(false);
    });

    it('never uses the turtle nesting census', () => {
        expect(isExcludedDataset('6a2c5c17-40cf-444f-8fda-c78fa257116f')).toBe(true);
        expect(isExcludedDataset('0264be1a-9d3f-495d-afcb-ac22718a70ce')).toBe(false);
    });

    it('keeps only sightings and specimens: no tracking, tag-release or eDNA rows', () => {
        // basisOfRecord is a whitelist now, compared without case.
        expect(keepRecord(rec({ basisOfRecord: 'humanObservation' }))).toBe(true);
        expect(keepRecord(rec({ basisOfRecord: 'Occurrence' }))).toBe(true);
        expect(keepRecord(rec({ basisOfRecord: 'MATERIAL_SAMPLE' }))).toBe(false);
        expect(keepRecord(rec({ basisOfRecord: 'MaterialSample' }))).toBe(false);
        expect(keepRecord(rec({ basisOfRecord: undefined }))).toBe(false);
        // Tracking datasets, whose human rows are tag releases, and eDNA.
        for (const id of [
            '0820b10a-5710-4e90-b9ed-a2ad7c7ec742', // IMOS acoustic tracking
            '48cb8624-a221-47ed-9a6d-b99b0bb394e0', // RAATD satellite tracking
            'e4dacf5c-6bfa-493e-8699-d65c31435107', // elasmobranch movement (tags)
            'b508f7bc-8708-43d5-b940-e44f2765d1af', // Australian Microbiome 18S (eDNA)
        ]) {
            expect(isExcludedDataset(id)).toBe(true);
        }
    });
});

describe('attribution', () => {
    it('fills a citation\'s "[month, year]" placeholder from the dataset\'s published date', () => {
        const vba =
            "Data Source: 'Victorian Biodiversity Atlas', © The State of Victoria, Department of Environment, Land, Water and Planning (published [month, year]).";
        expect(fillCitation(vba, '2022-06-07T05:57:07.000Z')).toBe(
            "Data Source: 'Victorian Biodiversity Atlas', © The State of Victoria, Department of Environment, Land, Water and Planning (published June 2022).",
        );
        expect(fillCitation('No placeholder here.', '2022-06-07T05:57:07.000Z')).toBe('No placeholder here.');
        expect(fillCitation(vba, null)).toBe(vba);
    });

    it('links the two licence deeds', () => {
        expect(LICENCE_URLS).toEqual({
            'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
            'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
        });
    });

    it('dates a record to a month only when its span is at most 31 days', () => {
        expect(monthOf(rec())).toBe(7);
        expect(monthOf(rec({ date_end: t('2020-07-15T00:00:00Z') + 31 * DAY }))).toBe(7);
        expect(monthOf(rec({ date_end: t('2020-07-15T00:00:00Z') + 32 * DAY }))).toBeNull();
        expect(monthOf(rec({ date_start: t('1990-01-01T00:00:00Z'), date_end: t('2000-12-31T00:00:00Z') }))).toBeNull();
    });
});

describe('cells', () => {
    it('0.25 deg for most species, 0.5 deg for threatened or unknown ones', () => {
        expect(cellDegFor({ sensitive: false })).toBe(0.25);
        expect(cellDegFor({ sensitive: true })).toBe(0.5);
        expect(cellDegFor(undefined)).toBe(0.5);
        expect(cellCentre(-27.1, 0.25)).toBe(-27.125);
        expect(cellCentre(153.6, 0.25, true)).toBe(153.625);
        expect(cellCentre(-27.1, 0.5)).toBe(-27.25);
        expect(cellCentre(-24.25, 0.25)).toBe(-24.125);
    });

    it('keeps a dateline cell on its own side, and writes 180 E as 180 W', () => {
        expect(cellCentre(179.9, 0.25, true)).toBe(179.875);
        expect(cellCentre(-179.9, 0.25, true)).toBe(-179.875);
        expect(cellCentre(180, 0.25, true)).toBe(-179.875);
        expect(cellCentre(-180, 0.5, true)).toBe(-179.75);
    });

    it('counts record-days, not rows: a colony census on one day counts once', () => {
        const census = Array.from({ length: 500 }, () => ({ datasetId: 'a', record: rec() }));
        const other = [
            { datasetId: 'b', record: rec() },
            {
                datasetId: 'a',
                record: rec({ date_start: t('2020-08-01T00:00:00Z'), date_end: t('2020-08-01T00:00:00Z') }),
            },
            {
                datasetId: 'a',
                record: rec({ date_start: t('1990-01-01T00:00:00Z'), date_end: t('2000-01-01T00:00:00Z') }),
            },
            { datasetId: 'a', record: rec({ basisOfRecord: 'MachineObservation' }) },
        ];
        const agg = aggregateSpecies([...census, ...other], 0.25);
        expect(agg.records).toBe(503);
        expect(agg.cells).toEqual([[-27.125, 153.625, 4, [0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0]]]);
        expect(agg.recordDays).toBe(4);
        expect(agg.years).toEqual([1990, 2020]);
    });

    it('drops a species under 50 clean records, with the reason', () => {
        expect(dropReason(49, 300)).toBe('only 49 licence-clean at-sea records (needs 50)');
        expect(dropReason(1, 1)).toBe('only 1 licence-clean at-sea record (needs 50)');
        expect(dropReason(0, 0)).toBe('no CC0 or CC BY records in this region');
        expect(dropReason(50, 50)).toBeNull();
    });
});

describe('the committed au-east file', () => {
    const file = JSON.parse(readFileSync('public/ocean-data/context/au-east.v1.json', 'utf8'));
    const catalogue = JSON.parse(readFileSync('data/sightings/species-qld-gbr.v1.json', 'utf8'));
    const known = new Map(catalogue.species.map((s: { scientificName: string }) => [s.scientificName, s]));

    it('says what it is, where it came from, and its policy', () => {
        expect(file).toMatchObject({ schema: 'thalassa-ocean-context', v: 1, region: { id: 'au-east' } });
        expect(file.licencePolicy).toMatch(/CC0 1\.0 or CC BY 4\.0 only/);
        expect(file.keptBasisOfRecord).toEqual(['HumanObservation', 'PreservedSpecimen', 'Occurrence']);
        expect(file.excluded.datasets.map((d: { id: string }) => d.id)).toContain(
            '6a2c5c17-40cf-444f-8fda-c78fa257116f',
        );
        expect(file.citation).toMatch(/^OBIS \(2026\) Ocean Biodiversity Information System/);
    });

    it('credits every dataset it used, each CC0 1.0 or CC BY 4.0 with a citation and a licence link', () => {
        expect(file.datasets.length).toBeGreaterThan(10);
        const ids = new Set(file.datasets.map((d: { id: string }) => d.id));
        expect(file.modification).toMatch(/changed from the original records/);
        expect(file.notes.length).toBeGreaterThan(0);
        for (const d of file.datasets) {
            expect(['CC BY 4.0', 'CC0 1.0']).toContain(d.licence);
            expect(d.licenceUrl).toBe(LICENCE_URLS[d.licence as keyof typeof LICENCE_URLS]);
            expect(d.citation.length).toBeGreaterThan(10);
            expect(d.citation).not.toMatch(/\[month, year\]/i);
            expect(d.url).toBe(`https://obis.org/dataset/${d.id}`);
            expect(d.records).toBeGreaterThan(0);
            expect(isExcludedDataset(d.id)).toBe(false);
        }
        expect(ids.has('6a2c5c17-40cf-444f-8fda-c78fa257116f')).toBe(false);
    });

    it('ships only species with 50 clean records, on the right grid, and never fish', () => {
        for (const s of file.species) {
            expect(s.records).toBeGreaterThanOrEqual(50);
            expect(s.group).not.toBe('fish');
            const entry = known.get(s.sci) as { sensitive?: boolean } | undefined;
            expect(s.cellDeg).toBe(entry && entry.sensitive === false ? 0.25 : 0.5);
            for (const [lat, lon, days, months] of s.cells) {
                expect(
                    Math.abs(((lat / s.cellDeg) % 1) - 0.5) < 1e-6 || Math.abs(((lat / s.cellDeg) % 1) + 0.5) < 1e-6,
                ).toBe(true);
                expect(lon).toBeGreaterThan(-180);
                expect(lon).toBeLessThan(180);
                expect(days).toBeGreaterThan(0);
                if (months) expect(months).toHaveLength(12);
            }
        }
        expect(file.species.map((s: { sci: string }) => s.sci)).toContain('Megaptera novaeangliae');
        for (const d of file.dropped) expect(d.reason).toMatch(/needs 50|no CC0 or CC BY/);
    });
});
