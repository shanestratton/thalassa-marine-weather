/**
 * CrewProfileService — Unit Tests
 *
 * Tests profile CRUD, customs manifest conversion,
 * and dietary summary generation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';

// ── Mock LocalDatabase ──────────────────────────────────────────
const mockProfiles: Record<string, any>[] = [];

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: vi.fn(() => mockProfiles),
    insertLocal: vi.fn((table: string, record: any) => {
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
            // Mock supabase to return null user
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: null },
            });

            // Use local profiles as fallback
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
            expect(manifest[0].role).toBe('Skipper'); // professional = Skipper
            expect(manifest[0].passport_number).toBe('PA123456');
        });

        it('assigns Crew role for non-professional experience', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: null },
            });

            mockProfiles.push({
                full_name: 'Deckhand Dave',
                nationality: 'British',
                passport_number: null,
                sailing_experience: 'competent',
                date_of_birth: null,
            });

            const manifest = await getCrewManifestForClearance();
            expect(manifest[0].role).toBe('Crew');
            expect(manifest[0].passport_number).toBeUndefined(); // null → undefined
        });
    });
});
