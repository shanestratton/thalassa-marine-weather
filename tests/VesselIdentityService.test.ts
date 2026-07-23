/**
 * VesselIdentityService — offline cache tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getCachedIdentity, syncIdentity, saveIdentity, type VesselIdentity } from '../services/VesselIdentityService';

describe('VesselIdentityService', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('u-1');
    });

    describe('getCachedIdentity', () => {
        it('returns null when nothing cached', () => {
            expect(getCachedIdentity()).toBeNull();
        });

        it('returns cached identity from localStorage', () => {
            const identity: VesselIdentity = {
                id: 'vi-1',
                owner_id: 'u-1',
                vessel_name: 'Thalassa',
                reg_number: 'NSW-12345',
                mmsi: '503123456',
                call_sign: 'VZX7890',
                phonetic_name: 'Tango Hotel Alpha Lima',
                vessel_type: 'sail',
                hull_color: 'White',
                model: 'Bavaria 40',
                updated_at: '2026-03-20T00:00:00Z',
            };
            localStorage.setItem('thalassa_vessel_identity', JSON.stringify(identity));
            const result = getCachedIdentity();
            expect(result).not.toBeNull();
            expect(result!.vessel_name).toBe('Thalassa');
            expect(result!.mmsi).toBe('503123456');
            expect(result!.vessel_type).toBe('sail');
        });

        it('returns null for corrupted data', () => {
            localStorage.setItem('thalassa_vessel_identity', '{broken json');
            expect(getCachedIdentity()).toBeNull();
        });

        it('never exposes one account’s vessel identity to another account', () => {
            const identity: VesselIdentity = {
                id: 'vi-private',
                owner_id: 'u-1',
                vessel_name: 'Account A only',
                reg_number: 'SECRET-1',
                mmsi: '503123456',
                call_sign: 'A-CALL',
                phonetic_name: 'Alpha',
                vessel_type: 'sail',
                hull_color: 'Blue',
                model: 'Test',
                updated_at: '2026-07-23T00:00:00.000Z',
            };
            localStorage.setItem(authScopedStorageKey('thalassa_vessel_identity'), JSON.stringify(identity));

            setAuthIdentityScope('u-2');

            expect(getCachedIdentity()).toBeNull();
        });

        it('does not adopt an owner-mismatched legacy vessel identity', () => {
            localStorage.setItem(
                'thalassa_vessel_identity',
                JSON.stringify({
                    id: 'legacy',
                    owner_id: 'someone-else',
                    vessel_name: 'Not this account',
                }),
            );

            expect(getCachedIdentity()).toBeNull();
        });
    });

    describe('syncIdentity (offline)', () => {
        it('returns cached identity when supabase is null', async () => {
            const identity: VesselIdentity = {
                id: 'vi-1',
                owner_id: 'u-1',
                vessel_name: 'Phoenix',
                reg_number: '',
                mmsi: '',
                call_sign: '',
                phonetic_name: '',
                vessel_type: 'power',
                hull_color: '',
                model: '',
                updated_at: '',
            };
            localStorage.setItem('thalassa_vessel_identity', JSON.stringify(identity));
            const result = await syncIdentity();
            expect(result?.vessel_name).toBe('Phoenix');
        });

        it('returns null when offline and nothing cached', async () => {
            const result = await syncIdentity();
            expect(result).toBeNull();
        });
    });

    describe('saveIdentity (offline)', () => {
        it('returns null when supabase is null', async () => {
            const result = await saveIdentity({ vessel_name: 'Test' });
            expect(result).toBeNull();
        });
    });

    describe('VesselIdentity type coverage', () => {
        it('covers all vessel types', () => {
            const types: VesselIdentity['vessel_type'][] = ['sail', 'power', 'observer'];
            expect(types).toHaveLength(3);
        });
    });
});
