/**
 * MarketplaceService — Unit tests for marketplace constants and types.
 */
import { describe, it, expect } from 'vitest';
import { LISTING_CATEGORIES, LISTING_CONDITIONS, CATEGORY_ICONS } from '../services/MarketplaceService';

describe('LISTING_CATEGORIES', () => {
    it('is a non-empty array', () => {
        expect(Array.isArray(LISTING_CATEGORIES)).toBe(true);
        expect(LISTING_CATEGORIES.length).toBeGreaterThan(0);
    });

    it('contains expected categories', () => {
        expect(LISTING_CATEGORIES).toContain('Sails');
        expect(LISTING_CATEGORIES).toContain('Electronics');
    });

    it('all categories are strings', () => {
        LISTING_CATEGORIES.forEach((cat) => {
            expect(typeof cat).toBe('string');
        });
    });
});

describe('LISTING_CONDITIONS', () => {
    it('contains standard conditions', () => {
        expect(LISTING_CONDITIONS).toContain('New');
        expect(LISTING_CONDITIONS).toContain('Like New');
        expect(LISTING_CONDITIONS).toContain('Used - Good');
    });

    it('has 5 condition levels', () => {
        expect(LISTING_CONDITIONS.length).toBe(5);
    });
});

describe('CATEGORY_ICONS', () => {
    it('has an icon for each category', () => {
        LISTING_CATEGORIES.forEach((cat) => {
            expect(CATEGORY_ICONS[cat]).toBeDefined();
            expect(typeof CATEGORY_ICONS[cat]).toBe('string');
        });
    });

    it('icons are non-empty', () => {
        Object.values(CATEGORY_ICONS).forEach((icon) => {
            expect(icon.length).toBeGreaterThan(0);
        });
    });
});
