/**
 * CustomsClearanceCard.test.ts — Tests for the customs clearance database.
 *
 * Validates database completeness, alias matching, and findCountryData logic.
 *
 * Since build 126 the guide is the packaged data file
 * public/data/customs-clearance.json joined to the synchronous port index
 * (data/customsPortIndex.ts); COUNTRY_DB here is that join, the same records
 * the card shows once the file has loaded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { findCountryData as findInGuide, joinClearance, type CountryClearanceDetails } from '../data/customsDb';
import { COUNTRY_ALIASES } from '../data/customsPortIndex';

const COUNTRY_DB = joinClearance(
    JSON.parse(readFileSync(join(process.cwd(), 'public/data/customs-clearance.json'), 'utf8')) as Record<
        string,
        CountryClearanceDetails
    >,
);
const findCountryData = (country: string | undefined) => findInGuide(country, COUNTRY_DB);

describe('COUNTRY_DB', () => {
    it('should contain at least 25 countries', () => {
        const count = Object.keys(COUNTRY_DB).length;
        expect(count).toBeGreaterThanOrEqual(25);
    });

    it('should have complete data for every entry', () => {
        for (const [key, data] of Object.entries(COUNTRY_DB)) {
            expect(data.country, `${key}: missing country name`).toBeTruthy();
            expect(data.flag, `${key}: missing flag`).toBeTruthy();
            expect(data.difficulty, `${key}: missing difficulty`).toMatch(/easy|moderate|complex/);
            expect(data.departureProcedure.length, `${key}: empty departureProcedure`).toBeGreaterThan(0);
            expect(data.arrivalProcedure.length, `${key}: empty arrivalProcedure`).toBeGreaterThan(0);
            expect(data.contacts.length, `${key}: no contacts`).toBeGreaterThan(0);
            expect(data.requiredDocuments.length, `${key}: no requiredDocuments`).toBeGreaterThan(0);
            expect(data.portsOfEntry.length, `${key}: no portsOfEntry`).toBeGreaterThan(0);
        }
    });

    it('should have at least one critical document per country', () => {
        for (const [key, data] of Object.entries(COUNTRY_DB)) {
            const hasCritical = data.requiredDocuments.some((d) => d.critical);
            expect(hasCritical, `${key}: no critical documents`).toBe(true);
        }
    });

    it('should include Australia with yacht export data', () => {
        const au = COUNTRY_DB['australia'];
        expect(au).toBeDefined();
        expect(au.yachtExport).toBeTruthy();
        expect(au.guideUrl).toBe('https://www.serene-summer.com');
    });
});

describe('COUNTRY_ALIASES', () => {
    it('should resolve Tahiti to French Polynesia', () => {
        expect(COUNTRY_ALIASES['tahiti']).toBe('french polynesia');
    });

    it('should resolve Turkey to Türkiye', () => {
        expect(COUNTRY_ALIASES['turkey']).toBe('türkiye');
    });

    it('should resolve UK to United Kingdom', () => {
        expect(COUNTRY_ALIASES['uk']).toBe('united kingdom');
    });

    it('should resolve BVI to British Virgin Islands', () => {
        expect(COUNTRY_ALIASES['bvi']).toBe('british virgin islands');
    });
});

describe('findCountryData', () => {
    it('should return undefined for empty input', () => {
        expect(findCountryData(undefined)).toBeUndefined();
        expect(findCountryData('')).toBeUndefined();
    });

    it('should match direct key', () => {
        const result = findCountryData('australia');
        expect(result?.country).toBe('Australia');
    });

    it('should match case-insensitively', () => {
        const result = findCountryData('AUSTRALIA');
        expect(result?.country).toBe('Australia');
    });

    it('should match via alias — Tahiti → French Polynesia', () => {
        const result = findCountryData('Tahiti');
        expect(result?.country).toBe('French Polynesia');
    });

    it('should match via alias — Turkey → Türkiye', () => {
        const result = findCountryData('Turkey');
        expect(result?.country).toBe('Türkiye');
    });

    it('should match via alias — England → United Kingdom', () => {
        const result = findCountryData('England');
        expect(result?.country).toBe('United Kingdom');
    });

    it('should match via alias — BVI → British Virgin Islands', () => {
        const result = findCountryData('BVI');
        expect(result?.country).toBe('British Virgin Islands');
    });

    it('should match via partial — "new zeal" → New Zealand', () => {
        const result = findCountryData('new zeal');
        expect(result?.country).toBe('New Zealand');
    });

    it('should handle whitespace', () => {
        const result = findCountryData('  australia  ');
        expect(result?.country).toBe('Australia');
    });
});
