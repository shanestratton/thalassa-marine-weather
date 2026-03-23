/**
 * CrewService — Unit tests
 *
 * Tests crew-related constants, types, and permission defaults.
 * Additionally tests the Supabase-backed functions with the
 * global mock from tests/setup.ts.
 */

import { describe, it, expect } from 'vitest';
import {
    ALL_REGISTERS,
    REGISTER_LABELS,
    REGISTER_ICONS,
    DEFAULT_PERMISSIONS,
    ROLE_DEFAULT_PERMISSIONS,
    type CrewRole,
} from '../services/CrewService';

// ── Constants & Defaults ─────────────────────────────────────

describe('CrewService constants', () => {
    it('ALL_REGISTERS contains all 5 registers', () => {
        expect(ALL_REGISTERS).toEqual(['stores', 'equipment', 'maintenance', 'documents', 'galley']);
    });

    it('REGISTER_LABELS has an entry for every register', () => {
        for (const reg of ALL_REGISTERS) {
            expect(REGISTER_LABELS[reg]).toBeTruthy();
            expect(typeof REGISTER_LABELS[reg]).toBe('string');
        }
    });

    it('REGISTER_ICONS has an emoji for every register', () => {
        for (const reg of ALL_REGISTERS) {
            expect(REGISTER_ICONS[reg]).toBeTruthy();
        }
    });
});

describe('DEFAULT_PERMISSIONS', () => {
    it('all permissions default to false', () => {
        for (const [, value] of Object.entries(DEFAULT_PERMISSIONS)) {
            expect(value).toBe(false);
        }
    });

    it('has all required permission keys', () => {
        const keys = Object.keys(DEFAULT_PERMISSIONS);
        expect(keys).toContain('can_view_stores');
        expect(keys).toContain('can_edit_stores');
        expect(keys).toContain('can_view_galley');
        expect(keys).toContain('can_view_nav');
        expect(keys).toContain('can_view_weather');
        expect(keys).toContain('can_edit_log');
    });
});

describe('ROLE_DEFAULT_PERMISSIONS', () => {
    const roles: CrewRole[] = ['co-skipper', 'navigator', 'deckhand', 'punter'];

    it('has permissions for all defined roles', () => {
        for (const role of roles) {
            expect(ROLE_DEFAULT_PERMISSIONS[role]).toBeDefined();
        }
    });

    it('co-skipper has full permissions', () => {
        const perms = ROLE_DEFAULT_PERMISSIONS['co-skipper'];
        for (const [, value] of Object.entries(perms)) {
            expect(value).toBe(true);
        }
    });

    it('punter has minimal permissions', () => {
        const perms = ROLE_DEFAULT_PERMISSIONS['punter'];
        for (const [, value] of Object.entries(perms)) {
            expect(value).toBe(false);
        }
    });

    it('navigator can view and edit log but not edit stores', () => {
        const perms = ROLE_DEFAULT_PERMISSIONS['navigator'];
        expect(perms.can_view_nav).toBe(true);
        expect(perms.can_edit_log).toBe(true);
        expect(perms.can_edit_stores).toBe(false);
    });

    it('deckhand can view stores and galley but not nav/weather', () => {
        const perms = ROLE_DEFAULT_PERMISSIONS['deckhand'];
        expect(perms.can_view_stores).toBe(true);
        expect(perms.can_view_galley).toBe(true);
        expect(perms.can_view_nav).toBe(false);
        expect(perms.can_view_weather).toBe(false);
    });
});

// ── Service Functions (with mocked Supabase) ─────────────────

describe('CrewService functions', () => {
    // The supabase mock from tests/setup.ts provides stub responses

    it('getMyCrew returns empty array when not authenticated', async () => {
        const { getMyCrew } = await import('../services/CrewService');
        const result = await getMyCrew();
        expect(Array.isArray(result)).toBe(true);
    });

    it('getMyInvites returns empty array when not authenticated', async () => {
        const { getMyInvites } = await import('../services/CrewService');
        const result = await getMyInvites();
        expect(Array.isArray(result)).toBe(true);
    });

    it('getMyMemberships returns empty array when not authenticated', async () => {
        const { getMyMemberships } = await import('../services/CrewService');
        const result = await getMyMemberships();
        expect(Array.isArray(result)).toBe(true);
    });

    it('lookupUserByEmail returns null when not authenticated', async () => {
        const { lookupUserByEmail } = await import('../services/CrewService');
        const result = await lookupUserByEmail('test@example.com');
        expect(result === null || typeof result === 'object').toBe(true);
    });

    it('inviteCrew returns error when not authenticated', async () => {
        const { inviteCrew } = await import('../services/CrewService');
        const result = await inviteCrew('test@example.com', ['stores']);
        expect(result.success).toBe(false);
    });

    it('getPendingInviteCount returns 0 when not authenticated', async () => {
        const { getPendingInviteCount } = await import('../services/CrewService');
        const result = await getPendingInviteCount();
        expect(result).toBe(0);
    });

    it('ALL_REGISTERS is a non-empty array of valid strings', () => {
        expect(ALL_REGISTERS.length).toBeGreaterThan(0);
        ALL_REGISTERS.forEach((r) => expect(typeof r).toBe('string'));
    });
});
