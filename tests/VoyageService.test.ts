/**
 * VoyageService — offline cache + type tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase
vi.mock('../services/supabase', () => ({ supabase: null }));

import { getCachedActiveVoyage, type Voyage, type VoyageStatus } from '../services/VoyageService';

describe('VoyageService', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('getCachedActiveVoyage', () => {
        it('returns null when no cached voyage', () => {
            expect(getCachedActiveVoyage()).toBeNull();
        });

        it('returns cached voyage from localStorage', () => {
            const voyage: Voyage = {
                id: 'v-1',
                user_id: 'u-1',
                vessel_id: null,
                voyage_name: 'Sydney to Auckland',
                departure_port: 'Sydney',
                destination_port: 'Auckland',
                departure_time: '2026-03-20T08:00:00Z',
                eta: '2026-03-28T10:00:00Z',
                crew_count: 4,
                status: 'active',
                weather_master_id: 'u-1',
                notes: null,
                created_at: '2026-03-20T06:00:00Z',
                updated_at: '2026-03-20T08:00:00Z',
            };
            localStorage.setItem('thalassa_active_voyage', JSON.stringify(voyage));
            const result = getCachedActiveVoyage();
            expect(result).not.toBeNull();
            expect(result!.voyage_name).toBe('Sydney to Auckland');
            expect(result!.status).toBe('active');
            expect(result!.crew_count).toBe(4);
        });

        it('returns null for corrupted localStorage data', () => {
            localStorage.setItem('thalassa_active_voyage', 'not-json{{{');
            expect(getCachedActiveVoyage()).toBeNull();
        });
    });

    describe('VoyageStatus type', () => {
        it('valid statuses', () => {
            const statuses: VoyageStatus[] = ['planning', 'active', 'completed', 'aborted'];
            expect(statuses).toHaveLength(4);
        });
    });

    describe('offline behavior', () => {
        it('createVoyage returns error when offline', async () => {
            const { createVoyage } = await import('../services/VoyageService');
            const result = await createVoyage({
                voyage_name: 'Test',
                departure_port: 'Sydney',
                destination_port: 'Auckland',
                crew_count: 2,
            });
            expect(result.voyage).toBeNull();
            expect(result.error).toContain('Offline');
        });

        it('startVoyage returns null when offline', async () => {
            const { startVoyage } = await import('../services/VoyageService');
            const result = await startVoyage('v-1');
            expect(result).toBeNull();
        });

        it('endVoyage returns false when offline', async () => {
            const { endVoyage } = await import('../services/VoyageService');
            const result = await endVoyage('v-1');
            expect(result).toBe(false);
        });

        it('getActiveVoyage returns cached when offline', async () => {
            const voyage: Voyage = {
                id: 'v-1',
                user_id: 'u-1',
                vessel_id: null,
                voyage_name: 'Cached Voyage',
                departure_port: 'Brisbane',
                destination_port: 'Noumea',
                departure_time: null,
                eta: null,
                crew_count: 3,
                status: 'active',
                weather_master_id: 'u-1',
                notes: null,
                created_at: '2026-03-20T00:00:00Z',
                updated_at: '2026-03-20T00:00:00Z',
            };
            localStorage.setItem('thalassa_active_voyage', JSON.stringify(voyage));
            const { getActiveVoyage } = await import('../services/VoyageService');
            const result = await getActiveVoyage();
            expect(result).not.toBeNull();
            expect(result!.voyage_name).toBe('Cached Voyage');
        });

        it('setWeatherMaster returns false when offline', async () => {
            const { setWeatherMaster } = await import('../services/VoyageService');
            const result = await setWeatherMaster('v-1', 'u-2');
            expect(result).toBe(false);
        });

        it('isWeatherMaster returns true when no active voyage (unrestricted)', async () => {
            const { isWeatherMaster } = await import('../services/VoyageService');
            const result = await isWeatherMaster();
            expect(result).toBe(true);
        });

        it('isWeatherMaster returns true when user is owner of cached voyage', async () => {
            const voyage: Voyage = {
                id: 'v-1',
                user_id: 'u-1',
                vessel_id: null,
                voyage_name: 'Test',
                departure_port: null,
                destination_port: null,
                departure_time: null,
                eta: null,
                crew_count: 2,
                status: 'active',
                weather_master_id: 'u-2', // Different weather master
                notes: null,
                created_at: '',
                updated_at: '',
            };
            localStorage.setItem('thalassa_active_voyage', JSON.stringify(voyage));
            localStorage.setItem('thalassa_user_id', 'u-1'); // Owner
            const { isWeatherMaster } = await import('../services/VoyageService');
            const result = await isWeatherMaster();
            expect(result).toBe(true); // Owner always has access
        });

        it('getDraftVoyages returns cached drafts when offline', async () => {
            const drafts = [{ id: 'v-1', voyage_name: 'Draft 1', status: 'planning' }];
            localStorage.setItem('thalassa_draft_voyages', JSON.stringify(drafts));
            const { getDraftVoyages } = await import('../services/VoyageService');
            const result = await getDraftVoyages();
            expect(result).toHaveLength(1);
            expect(result[0].voyage_name).toBe('Draft 1');
        });

        it('getDraftVoyages returns empty array when no cache', async () => {
            const { getDraftVoyages } = await import('../services/VoyageService');
            const result = await getDraftVoyages();
            expect(result).toEqual([]);
        });
    });
});
