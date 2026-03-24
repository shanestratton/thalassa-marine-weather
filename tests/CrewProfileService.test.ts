/**
 * CrewProfileService — Unit Tests
 *
 * Tests dietary summary and customs manifest conversion.
 * Uses properly resolving Supabase mock chains.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';

// ── Mock LocalDatabase ──────────────────────────────────────────
const mockProfiles: Record<string, any>[] = [];

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: vi.fn(() => [...mockProfiles]),
    insertLocal: vi.fn((_table: string, record: any) => {
        mockProfiles.push(record);
        return record;
    }),
    updateLocal: vi.fn((_table: string, id: string, updates: any) => {
        const idx = mockProfiles.findIndex((p) => p.id === id);
        if (idx >= 0) {
            Object.assign(mockProfiles[idx], updates);
            return mockProfiles[idx];
        }
        return null;
    }),
    generateUUID: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).slice(2, 8)),
}));

import { getCrewDietarySummary, getCrewManifestForClearance } from '../services/CrewProfileService';

describe('CrewProfileService', () => {
    beforeEach(() => {
        mockProfiles.length = 0;
        vi.clearAllMocks();
    });

    describe('getCrewDietarySummary', () => {
        it('returns empty for no profiles', () => {
            expect(getCrewDietarySummary()).toEqual([]);
        });

        it('returns only profiles with dietary notes', () => {
            mockProfiles.push(
                { full_name: 'Alice', dietary_notes: 'Vegetarian' },
                { full_name: 'Bob', dietary_notes: null },
                { full_name: 'Carol', dietary_notes: 'Gluten-free' },
            );

            const result = getCrewDietarySummary();
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ name: 'Alice', dietary: 'Vegetarian' });
            expect(result[1]).toEqual({ name: 'Carol', dietary: 'Gluten-free' });
        });
    });

    describe('getCrewManifestForClearance', () => {
        it('maps profiles to customs manifest format', async () => {
            // Mock supabase.from chain to resolve properly
            const chain = {
                select: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            // Local profiles as fallback (supabase returns no data)
            mockProfiles.push({
                full_name: 'Captain Shane',
                nationality: 'Australian',
                passport_number: 'PA123456',
                sailing_experience: 'professional',
                date_of_birth: '1985-01-15',
            });

            const manifest = await getCrewManifestForClearance();
            expect(manifest).toHaveLength(1);
            expect(manifest[0].name).toBe('Captain Shane');
            expect(manifest[0].nationality).toBe('Australian');
            expect(manifest[0].role).toBe('Skipper');
            expect(manifest[0].passport_number).toBe('PA123456');
        });

        it('assigns Crew role for non-professional experience', async () => {
            const chain = {
                select: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            mockProfiles.push({
                full_name: 'Deckhand Dave',
                nationality: 'British',
                passport_number: null,
                sailing_experience: 'competent',
                date_of_birth: null,
            });

            const manifest = await getCrewManifestForClearance();
            expect(manifest[0].role).toBe('Crew');
            expect(manifest[0].passport_number).toBeUndefined();
        });
    });
});
