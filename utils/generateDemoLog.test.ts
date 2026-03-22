/**
 * generateDemoLog — Unit tests for demo voyage data generation.
 */
import { describe, it, expect } from 'vitest';
import { generateDemoVoyage } from './generateDemoLog';

describe('generateDemoVoyage', () => {
    it('returns a non-empty array', () => {
        const entries = generateDemoVoyage();
        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThan(0);
    });

    it('entries have id and timestamp', () => {
        const entries = generateDemoVoyage();
        entries.forEach((entry) => {
            expect(entry).toHaveProperty('id');
            expect(entry).toHaveProperty('timestamp');
        });
    });

    it('entries have valid timestamps', () => {
        const entries = generateDemoVoyage();
        entries.forEach((entry) => {
            expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
        });
    });

    it('generates multiple entries', () => {
        const entries = generateDemoVoyage();
        expect(entries.length).toBeGreaterThan(5);
    });

    it('generates consistent results across calls', () => {
        const entries1 = generateDemoVoyage();
        const entries2 = generateDemoVoyage();
        expect(entries1.length).toBe(entries2.length);
    });

    it('each entry has a voyageId', () => {
        const entries = generateDemoVoyage();
        entries.forEach((entry) => {
            expect(entry).toHaveProperty('voyageId');
        });
    });
});
