/**
 * LonelyHeartsService — Constants & Type Validation Tests
 *
 * Tests that exported constants (SKILL_OPTIONS, AGE_RANGES, etc.)
 * are correct and well-formed. Also validates type guards.
 */
import { describe, it, expect } from 'vitest';
import {
    SKILL_OPTIONS,
    GENDER_OPTIONS,
    AGE_RANGES,
    EXPERIENCE_LEVELS,
    LISTING_TYPES,
    VIBE_OPTIONS,
    LANGUAGE_OPTIONS,
    SMOKING_OPTIONS,
    DRINKING_OPTIONS,
    PET_OPTIONS,
    SUPER_LIKE_DAILY_LIMIT,
    INTEREST_OPTIONS,
    SEEKING_OPTIONS,
} from '../services/LonelyHeartsService';

describe('LonelyHeartsService — Constants', () => {
    it('SKILL_OPTIONS has expected skills', () => {
        expect(SKILL_OPTIONS).toContain('🍳 Cooking');
        expect(SKILL_OPTIONS).toContain('🧭 Navigation');
        expect(SKILL_OPTIONS).toContain('⚙️ Diesel Engines');
        expect(SKILL_OPTIONS.length).toBeGreaterThanOrEqual(10);
    });

    it('GENDER_OPTIONS includes Male and Female', () => {
        expect(GENDER_OPTIONS).toContain('Male');
        expect(GENDER_OPTIONS).toContain('Female');
    });

    it('AGE_RANGES covers expected ranges', () => {
        expect(AGE_RANGES).toEqual(['18-25', '26-35', '36-45', '46-55', '56-65', '65+']);
    });

    it('EXPERIENCE_LEVELS has progression', () => {
        expect(EXPERIENCE_LEVELS[0]).toBe('Just Got My Sea Legs');
        expect(EXPERIENCE_LEVELS[EXPERIENCE_LEVELS.length - 1]).toBe('Salty Dog 🧂');
        expect(EXPERIENCE_LEVELS.length).toBe(6);
    });

    it('LISTING_TYPES has seeking_crew and seeking_berth', () => {
        const keys = LISTING_TYPES.map((lt) => lt.key);
        expect(keys).toContain('seeking_crew');
        expect(keys).toContain('seeking_berth');
        expect(LISTING_TYPES).toHaveLength(2);
    });

    it('LISTING_TYPES entries have key, label, and icon', () => {
        for (const lt of LISTING_TYPES) {
            expect(lt.key).toBeTruthy();
            expect(lt.label).toBeTruthy();
            expect(lt.icon).toBeTruthy();
        }
    });

    it('VIBE_OPTIONS has expected vibes', () => {
        expect(VIBE_OPTIONS).toContain('🌴 Cruisy');
        expect(VIBE_OPTIONS.length).toBeGreaterThanOrEqual(5);
    });

    it('LANGUAGE_OPTIONS includes common languages', () => {
        const labels = LANGUAGE_OPTIONS.map((l) => l.split(' ')[1]);
        expect(labels).toContain('English');
        expect(labels).toContain('French');
    });

    it('SMOKING_OPTIONS has 3 levels', () => {
        expect(SMOKING_OPTIONS).toEqual(['Non-Smoker', 'Social Smoker', 'Smoker']);
    });

    it('DRINKING_OPTIONS has 3 levels', () => {
        expect(DRINKING_OPTIONS).toEqual(['Non-Drinker', 'Social Drinker', 'Regular']);
    });

    it('PET_OPTIONS covers all scenarios', () => {
        expect(PET_OPTIONS).toContain('No Pets');
        expect(PET_OPTIONS.length).toBe(4);
    });

    it('SUPER_LIKE_DAILY_LIMIT is 1', () => {
        expect(SUPER_LIKE_DAILY_LIMIT).toBe(1);
    });

    it('INTEREST_OPTIONS is comprehensive', () => {
        expect(INTEREST_OPTIONS).toContain('⛵ Sailing');
        expect(INTEREST_OPTIONS.length).toBeGreaterThanOrEqual(30);
    });

    it('SEEKING_OPTIONS has expected values', () => {
        expect(SEEKING_OPTIONS).toContain('Crew Mate');
        expect(SEEKING_OPTIONS).toContain('Open to Anything');
    });

    it('all option arrays contain only strings', () => {
        const allArrays = [
            SKILL_OPTIONS,
            GENDER_OPTIONS,
            AGE_RANGES,
            EXPERIENCE_LEVELS,
            VIBE_OPTIONS,
            LANGUAGE_OPTIONS,
            SMOKING_OPTIONS,
            DRINKING_OPTIONS,
            PET_OPTIONS,
            INTEREST_OPTIONS,
            SEEKING_OPTIONS,
        ];
        for (const arr of allArrays) {
            for (const item of arr) {
                expect(typeof item).toBe('string');
            }
        }
    });

    it('no duplicate values in SKILL_OPTIONS', () => {
        expect(new Set(SKILL_OPTIONS).size).toBe(SKILL_OPTIONS.length);
    });

    it('no duplicate values in INTEREST_OPTIONS', () => {
        expect(new Set(INTEREST_OPTIONS).size).toBe(INTEREST_OPTIONS.length);
    });
});
