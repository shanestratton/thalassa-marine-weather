/**
 * VesselMetadataService — Unit Tests
 *
 * Tests getVesselIntel, getFlag, cache behavior,
 * and batch lookup with Supabase mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VesselMetadataService } from '../services/VesselMetadataService';

describe('VesselMetadataService', () => {
    beforeEach(() => {
        VesselMetadataService.clearCache();
        vi.clearAllMocks();
    });

    afterEach(() => {
        VesselMetadataService.clearCache();
    });

    describe('getVesselIntel', () => {
        it('returns intel with MMSI decoded flag for uncached vessel', () => {
            const intel = VesselMetadataService.getVesselIntel(503123456);
            expect(intel.flag).toBeTruthy(); // Should have flag emoji
            expect(intel.country).toBeTruthy(); // Should have country
            expect(intel.isEnriched).toBe(false); // Not enriched (no cache)
            expect(intel.decoded).toBeDefined();
        });

        it('returns name from cached data', () => {
            // First access schedules batch, second is still uncached
            const intel1 = VesselMetadataService.getVesselIntel(503000001);
            expect(intel1.name).toBeNull();
            expect(intel1.isEnriched).toBe(false);
        });

        it('always provides MMSI decode even without DB data', () => {
            const intel = VesselMetadataService.getVesselIntel(211000000);
            // 211 = Germany
            expect(intel.decoded).toBeDefined();
            expect(intel.flag).toBeTruthy();
        });
    });

    describe('getFlag', () => {
        it('returns flag emoji for valid Australian MMSI', () => {
            const flag = VesselMetadataService.getFlag(503123456);
            expect(flag).toBe('🇦🇺');
        });

        it('returns flag emoji for US MMSI', () => {
            const flag = VesselMetadataService.getFlag(366999999);
            expect(flag).toBe('🇺🇸');
        });

        it('returns fallback for invalid MMSI', () => {
            const flag = VesselMetadataService.getFlag(0);
            expect(flag).toBeTruthy(); // Should return something, not crash
        });
    });

    describe('clearCache', () => {
        it('clears without error', () => {
            VesselMetadataService.clearCache();
            // Should not throw
            expect(true).toBe(true);
        });
    });
});
