import { describe, it, expect } from 'vitest';
import { searchPolarDatabase, POLAR_DATABASE } from '../data/polarDatabase';

describe('POLAR_DATABASE', () => {
    it('has entries', () => {
        expect(POLAR_DATABASE.length).toBeGreaterThan(200);
    });

    it('each entry has required fields', () => {
        POLAR_DATABASE.forEach((entry) => {
            expect(entry.model).toBeTruthy();
            expect(entry.manufacturer).toBeTruthy();
            expect(entry.loa).toBeGreaterThan(0);
            expect(['cruiser', 'racer-cruiser', 'racer', 'multihull']).toContain(entry.category);
            expect(entry.polar).toBeDefined();
            expect(entry.polar.windSpeeds).toHaveLength(7);
            expect(entry.polar.angles).toHaveLength(6);
            expect(entry.polar.matrix).toHaveLength(6);
        });
    });

    it('polar matrix values are positive', () => {
        POLAR_DATABASE.forEach((entry) => {
            entry.polar.matrix.forEach((row) => {
                row.forEach((speed) => {
                    expect(speed).toBeGreaterThan(0);
                });
            });
        });
    });

    it('larger boats have higher speeds at same conditions', () => {
        const small = POLAR_DATABASE.find((e) => e.model === 'Catalina 22');
        const big = POLAR_DATABASE.find((e) => e.model === 'Catalina 42');
        expect(small).toBeDefined();
        expect(big).toBeDefined();
        // At 10kts wind (index 2), beam reach (90°, index 2)
        const smallSpeed = small!.polar.matrix[2][2];
        const bigSpeed = big!.polar.matrix[2][2];
        expect(bigSpeed).toBeGreaterThan(smallSpeed);
    });

    it('racers are faster than cruisers of similar size', () => {
        // Both ~30ft, but different categories
        const cruiser = POLAR_DATABASE.find((e) => e.model === 'Catalina 30');
        const racer = POLAR_DATABASE.find((e) => e.model === 'Beneteau First 30');
        expect(cruiser).toBeDefined();
        expect(racer).toBeDefined();
        const cruiserSpeed = cruiser!.polar.matrix[2][2]; // beam reach, 10kts
        const racerSpeed = racer!.polar.matrix[2][2];
        expect(racerSpeed).toBeGreaterThan(cruiserSpeed);
    });
});

describe('searchPolarDatabase', () => {
    it('returns all entries for empty query', () => {
        const results = searchPolarDatabase('');
        expect(results.length).toBe(POLAR_DATABASE.length);
    });

    it('finds boats by model name', () => {
        const results = searchPolarDatabase('J/105');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].model).toContain('J/105');
    });

    it('finds boats by manufacturer', () => {
        const results = searchPolarDatabase('Beneteau');
        expect(results.length).toBeGreaterThan(10);
        expect(results.every((r) => r.manufacturer === 'Beneteau' || r.model.includes('Beneteau'))).toBe(true);
    });

    it('search is case insensitive', () => {
        const upper = searchPolarDatabase('LAGOON');
        const lower = searchPolarDatabase('lagoon');
        expect(upper.length).toBe(lower.length);
    });

    it('returns empty array for non-matching query', () => {
        const results = searchPolarDatabase('zzz_nonexistent_boat_999');
        expect(results.length).toBe(0);
    });

    it('finds multihulls', () => {
        const results = searchPolarDatabase('Lagoon 42');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].category).toBe('multihull');
    });

    it('finds by partial model name', () => {
        const results = searchPolarDatabase('Oceanis');
        expect(results.length).toBeGreaterThan(5);
    });

    it('results are sorted by manufacturer', () => {
        const results = searchPolarDatabase('');
        for (let i = 1; i < results.length; i++) {
            const cmp = results[i - 1].manufacturer.localeCompare(results[i].manufacturer);
            if (cmp === 0) {
                expect(results[i - 1].loa).toBeLessThanOrEqual(results[i].loa);
            } else {
                expect(cmp).toBeLessThanOrEqual(0);
            }
        }
    });
});
