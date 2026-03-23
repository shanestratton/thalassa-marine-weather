/**
 * PinService — saved pin coordinate formatting tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase (all Supabase calls return null/empty when not connected)
vi.mock('../services/supabase', () => ({
    supabase: null,
}));

import { PinService } from '../services/PinService';

describe('PinService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('formatCoords', () => {
        it('formats positive lat/lng (Northern/Eastern hemisphere)', () => {
            const result = PinService.formatCoords(-33.8568, 151.2153);
            expect(result).toBe('33.8568°S, 151.2153°E');
        });

        it('formats negative lat as S', () => {
            const result = PinService.formatCoords(-33.8568, 151.2153);
            expect(result).toContain('S');
        });

        it('formats negative lng as W', () => {
            const result = PinService.formatCoords(40.7128, -74.006);
            expect(result).toBe('40.7128°N, 74.0060°W');
        });

        it('formats positive lat as N', () => {
            const result = PinService.formatCoords(51.5074, -0.1278);
            expect(result).toContain('N');
        });

        it('formats zero coordinates', () => {
            const result = PinService.formatCoords(0, 0);
            expect(result).toBe('0.0000°N, 0.0000°E');
        });

        it('formats typical Pacific sailing coordinates', () => {
            // Fiji
            const result = PinService.formatCoords(-17.7134, 177.986);
            expect(result).toBe('17.7134°S, 177.9860°E');
        });
    });

    describe('savePin (offline)', () => {
        it('returns null when supabase is null', async () => {
            const result = await PinService.savePin({
                latitude: -33.8568,
                longitude: 151.2153,
                caption: 'Test Pin',
            });
            expect(result).toBeNull();
        });
    });

    describe('getMyPins (offline)', () => {
        it('returns empty array when supabase is null', async () => {
            const result = await PinService.getMyPins();
            expect(result).toEqual([]);
        });
    });

    describe('deletePin (offline)', () => {
        it('returns false when supabase is null', async () => {
            const result = await PinService.deletePin('some-id');
            expect(result).toBe(false);
        });
    });
});
