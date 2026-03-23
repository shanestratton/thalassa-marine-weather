import { describe, it, expect } from 'vitest';
import { decodeMmsi, getMidInfo, getScrapePriority, getMmsiFlag, getMmsiCountry } from '../utils/MmsiDecoder';

describe('decodeMmsi', () => {
    it('decodes Australian MMSI correctly', () => {
        const result = decodeMmsi(503123456);
        expect(result.mid).toBe(503);
        expect(result.country).toBe('Australia');
        expect(result.flag).toBe('🇦🇺');
        expect(result.region).toBe('oceania');
        expect(result.isVessel).toBe(true);
    });

    it('decodes US MMSI (366) correctly', () => {
        const result = decodeMmsi(366123456);
        expect(result.country).toBe('United States');
        expect(result.flag).toBe('🇺🇸');
        expect(result.region).toBe('americas');
    });

    it('decodes UK MMSI (232) correctly', () => {
        const result = decodeMmsi(232123456);
        expect(result.country).toBe('United Kingdom');
        expect(result.flag).toBe('🇬🇧');
        expect(result.region).toBe('europe');
    });

    it('decodes NZ MMSI correctly', () => {
        const result = decodeMmsi(512987654);
        expect(result.country).toBe('New Zealand');
        expect(result.region).toBe('oceania');
    });

    it('decodes Japan MMSI correctly', () => {
        const result = decodeMmsi(431000001);
        expect(result.country).toBe('Japan');
        expect(result.region).toBe('asia');
    });

    it('decodes Panama MMSI correctly', () => {
        const result = decodeMmsi(370000001);
        expect(result.country).toBe('Panama');
        expect(result.region).toBe('americas');
    });

    it('handles string MMSI input', () => {
        const result = decodeMmsi('503123456');
        expect(result.country).toBe('Australia');
        expect(result.mmsi).toBe(503123456);
    });

    it('returns Unknown for unknown MID', () => {
        const result = decodeMmsi(999999999);
        expect(result.country).toBe('Unknown');
        expect(result.flag).toBe('🏴');
        expect(result.region).toBe('unknown');
    });

    it('detects non-vessel MMSI (coast station)', () => {
        const result = decodeMmsi(100000001);
        expect(result.isVessel).toBe(false);
    });

    it('detects vessel MMSI range 2-7', () => {
        [2, 3, 4, 5, 6, 7].forEach((firstDigit) => {
            const mmsi = firstDigit * 100000000 + 3000001;
            const result = decodeMmsi(mmsi);
            expect(result.isVessel).toBe(true);
        });
    });

    it('handles South Africa correctly', () => {
        const result = decodeMmsi(601000001);
        expect(result.country).toBe('South Africa');
        expect(result.region).toBe('africa');
    });

    it('handles Singapore correctly', () => {
        const result = decodeMmsi(564000001);
        expect(result.country).toBe('Singapore');
        expect(result.region).toBe('asia');
    });
});

describe('getMidInfo', () => {
    it('returns info for known MID', () => {
        const info = getMidInfo(503);
        expect(info.country).toBe('Australia');
        expect(info.flag).toBe('🇦🇺');
        expect(info.mid).toBe(503);
    });

    it('returns Unknown for unknown MID', () => {
        const info = getMidInfo(999);
        expect(info.country).toBe('Unknown');
    });
});

describe('getScrapePriority', () => {
    it('returns 1 for Australia', () => {
        expect(getScrapePriority(503123456)).toBe(1);
    });

    it('returns 2 for USA (366)', () => {
        expect(getScrapePriority(366123456)).toBe(2);
    });

    it('returns 2 for USA (338)', () => {
        expect(getScrapePriority(338123456)).toBe(2);
    });

    it('returns 2 for USA (369)', () => {
        expect(getScrapePriority(369123456)).toBe(2);
    });

    it('returns 3 for European countries', () => {
        expect(getScrapePriority(232123456)).toBe(3); // UK
        expect(getScrapePriority(211123456)).toBe(3); // Germany
        expect(getScrapePriority(226123456)).toBe(3); // France
    });

    it('returns 4 for Asian countries', () => {
        expect(getScrapePriority(431123456)).toBe(4); // Japan
    });

    it('returns 4 for African countries', () => {
        expect(getScrapePriority(601123456)).toBe(4); // South Africa
    });

    it('handles string input', () => {
        expect(getScrapePriority('503123456')).toBe(1);
    });
});

describe('getMmsiFlag', () => {
    it('returns AU flag', () => {
        expect(getMmsiFlag(503123456)).toBe('🇦🇺');
    });

    it('returns unknown flag for invalid MMSI', () => {
        expect(getMmsiFlag(999999999)).toBe('🏴');
    });
});

describe('getMmsiCountry', () => {
    it('returns Australia for AU MMSI', () => {
        expect(getMmsiCountry(503123456)).toBe('Australia');
    });

    it('returns Unknown for invalid MMSI', () => {
        expect(getMmsiCountry(999999999)).toBe('Unknown');
    });
});
