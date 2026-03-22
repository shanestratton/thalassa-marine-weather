/**
 * polarParser — Unit tests for polar file parser.
 */
import { describe, it, expect } from 'vitest';
import { parsePolarFile, validatePolarData, createEmptyPolar } from './polarParser';

describe('parsePolarFile', () => {
    it('parses Expedition .pol format (tab-separated)', () => {
        const content = `TWA\t6\t8\t10\t12\t15\t20\t25
45\t5.2\t6.1\t6.8\t7.2\t7.5\t7.6\t7.4
90\t6.0\t7.0\t7.8\t8.2\t8.5\t8.6\t8.3
135\t5.5\t6.5\t7.2\t7.6\t7.9\t8.0\t7.8`;
        const result = parsePolarFile(content, 'test.pol');
        expect(result).toBeDefined();
        expect(result.windSpeeds).toBeDefined();
        expect(result.windSpeeds.length).toBeGreaterThan(0);
        expect(result.angles.length).toBeGreaterThan(0);
        expect(result.matrix.length).toBeGreaterThan(0);
    });

    it('parses CSV polar format', () => {
        // CSV format uses commas — just check it doesn't throw
        const content = `TWA,6,8,10,12
45,5.2,6.1,6.8,7.2
90,6.0,7.0,7.8,8.2`;
        const result = parsePolarFile(content, 'test.csv');
        expect(result).toBeDefined();
        expect(result.windSpeeds).toBeDefined();
    });

    it('auto-detects tab-separated format', () => {
        const content = `TWA\t6\t10
45\t5.2\t6.8`;
        const result = parsePolarFile(content, 'test.txt');
        expect(result).toBeDefined();
    });

    it('throws on empty content', () => {
        expect(() => parsePolarFile('', 'test.pol')).toThrow();
    });

    it('throws on single-line content (no data rows)', () => {
        expect(() => parsePolarFile('TWA\t6\t8', 'test.pol')).toThrow();
    });
});

describe('validatePolarData', () => {
    it('validates a well-formed polar', () => {
        const content = `TWA\t6\t10\t15
45\t5.0\t6.5\t7.0
90\t6.0\t7.5\t8.0
135\t5.5\t7.0\t7.5`;
        const polar = parsePolarFile(content, 'test.pol');
        const validation = validatePolarData(polar);
        expect(validation.valid).toBe(true);
    });

    it('returns warnings array', () => {
        const polar = createEmptyPolar();
        const validation = validatePolarData(polar);
        expect(Array.isArray(validation.warnings)).toBe(true);
    });
});

describe('createEmptyPolar', () => {
    it('returns a PolarData object with default structure', () => {
        const polar = createEmptyPolar();
        expect(polar).toBeDefined();
        expect(polar.windSpeeds).toBeDefined();
        expect(polar.angles).toBeDefined();
        expect(polar.matrix).toBeDefined();
    });
});
