/**
 * MmsiDecoder — Unit tests for MMSI decoding utility.
 */
import { describe, it, expect } from 'vitest';
import { decodeMmsi, getMidInfo, getScrapePriority } from './MmsiDecoder';

describe('decodeMmsi', () => {
    it('decodes a valid Australian MMSI', () => {
        const result = decodeMmsi(503000000);
        expect(result.country).toBe('Australia');
        expect(result.mid).toBe(503);
    });

    it('decodes a valid US MMSI', () => {
        const result = decodeMmsi(366000000);
        expect(result.mid).toBe(366);
    });

    it('handles string MMSI input', () => {
        const result = decodeMmsi('503000000');
        expect(result.country).toBe('Australia');
    });

    it('returns unknown for invalid MMSI', () => {
        const result = decodeMmsi(0);
        expect(result.country).toBe('Unknown');
    });
});

describe('getMidInfo', () => {
    it('returns info for known MID', () => {
        const result = getMidInfo(503);
        expect(result.country).toBe('Australia');
    });

    it('returns Unknown for unknown MID', () => {
        const result = getMidInfo(999);
        expect(result.country).toBe('Unknown');
    });
});

describe('getScrapePriority', () => {
    it('returns priority 1-4 for any MMSI', () => {
        const priority = getScrapePriority(503000000);
        expect(priority).toBeGreaterThanOrEqual(1);
        expect(priority).toBeLessThanOrEqual(4);
    });
});
