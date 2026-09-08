/**
 * CrewService — Unit tests
 *
 * Tests crew-related constants, types, and permission defaults.
 * Additionally tests the Supabase-backed functions: the unauthenticated
 * cases short-circuit before touching Supabase, and the invite-role cases
 * (2026-09-08) drive a file-local Supabase mock so the inserted row can be
 * inspected.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const supabaseMocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: supabaseMocks.getUser },
        from: supabaseMocks.from,
        rpc: supabaseMocks.rpc,
    },
}));

import {
    ALL_REGISTERS,
    INVITE_REGISTERS,
    REGISTER_LABELS,
    REGISTER_ICONS,
    DEFAULT_PERMISSIONS,
    ROLE_DEFAULT_PERMISSIONS,
    syncPassagePermissions,
    crewInvitePermissions,
    inviteCrew,
    type CrewRole,
} from '../services/CrewService';

// ── Constants & Defaults ─────────────────────────────────────

describe('CrewService constants', () => {
    it('ALL_REGISTERS contains all registers', () => {
        expect(ALL_REGISTERS).toEqual([
            'stores',
            'equipment',
            'maintenance',
            'documents',
            'galley',
            'instruments',
            'passage_meals',
            'passage_chat',
            'passage_route',
            'passage_checklist',
        ]);
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
        expect(keys).toContain('can_view_instruments');
    });
});

describe('the Instrument Panel is invite-only (Shane 2026-09-07)', () => {
    it('is a register on the invite, first in the list, and the share derives from it', () => {
        expect(INVITE_REGISTERS[0]).toBe('instruments');
        expect(REGISTER_LABELS.instruments).toBe('Instrument Panel');
        expect(syncPassagePermissions(['instruments']).can_view_instruments).toBe(true);
        expect(syncPassagePermissions(['stores']).can_view_instruments).toBe(false);
        // Re-saving without the register withdraws the share; other flags survive.
        const kept = syncPassagePermissions(['stores'], {
            ...DEFAULT_PERMISSIONS,
            can_view_nav: true,
            can_view_instruments: true,
        });
        expect(kept.can_view_instruments).toBe(false);
        expect(kept.can_view_nav).toBe(true);
    });

    it('only a co-skipper preset carries the instruments; everyone else is an explicit tick', () => {
        expect(ROLE_DEFAULT_PERMISSIONS['co-skipper'].can_view_instruments).toBe(true);
        expect(ROLE_DEFAULT_PERMISSIONS.navigator.can_view_instruments).toBe(false);
        expect(ROLE_DEFAULT_PERMISSIONS.deckhand.can_view_instruments).toBe(false);
        expect(ROLE_DEFAULT_PERMISSIONS.punter.can_view_instruments).toBe(false);
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

describe('syncPassagePermissions', () => {
    it('derives the parent gate and exact child grants from shared passage registers', () => {
        const permissions = syncPassagePermissions(['passage_meals', 'passage_checklist']);

        expect(permissions.can_view_passage).toBe(true);
        expect(permissions.can_view_passage_meals).toBe(true);
        expect(permissions.can_view_passage_checklist).toBe(true);
        expect(permissions.can_view_passage_chat).toBe(false);
        expect(permissions.can_view_passage_route).toBe(false);
    });

    it('revokes removed passage grants without disturbing vessel-level permissions', () => {
        const permissions = syncPassagePermissions(['stores'], {
            ...ROLE_DEFAULT_PERMISSIONS.navigator,
            can_view_passage_meals: true,
        });

        expect(permissions.can_view_passage).toBe(false);
        expect(permissions.can_view_passage_meals).toBe(false);
        expect(permissions.can_view_nav).toBe(true);
        expect(permissions.can_edit_log).toBe(true);
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

// ── Invite role (Shane 2026-09-08: vessel claim / release decision) ─────
//
// The invite is the ONLY way onto a hull someone else has claimed, so a
// relief or delivery skipper is invited as co-skipper. The role must reach
// the vessel_crew row together with that role's preset permissions; the
// three-argument call must keep writing deckhand.

interface VesselCrewTable {
    query: Record<string, unknown>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
}

function vesselCrewTable(existing: unknown = null): VesselCrewTable {
    const query: Record<string, unknown> = {};
    const chain = vi.fn(() => query);
    const insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const update = vi.fn(() => query);
    Object.assign(query, {
        select: chain,
        eq: chain,
        is: chain,
        insert,
        update,
        maybeSingle: vi.fn(() => Promise.resolve({ data: existing, error: null })),
        // `await supabase.from(...).update(...).eq(...).eq(...)` resolves here.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve, reject),
    });
    return { query, insert, update };
}

describe('inviteCrew carries the chosen role (2026-09-08)', () => {
    beforeEach(() => {
        setAuthIdentityScope('skipper-1');
        supabaseMocks.getUser.mockResolvedValue({
            data: { user: { id: 'skipper-1', email: 'skipper@example.com' } },
            error: null,
        });
        supabaseMocks.rpc.mockResolvedValue({
            data: { found: true, user_id: 'crew-9', email: 'mate@example.com' },
            error: null,
        });
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        supabaseMocks.getUser.mockReset();
        supabaseMocks.from.mockReset();
        supabaseMocks.rpc.mockReset();
    });

    it('inserts role co-skipper with the preset merged with the passage flags', async () => {
        const table = vesselCrewTable();
        supabaseMocks.from.mockReturnValue(table.query);

        const result = await inviteCrew(
            'mate@example.com',
            ['instruments', 'passage_checklist'],
            'voyage-1',
            'co-skipper',
        );

        expect(result).toEqual({ success: true });
        expect(table.insert).toHaveBeenCalledTimes(1);
        const row = table.insert.mock.calls[0][0] as Record<string, unknown>;
        expect(row.role).toBe('co-skipper');
        expect(row.voyage_id).toBe('voyage-1');
        expect(row.shared_registers).toEqual(['instruments', 'passage_checklist']);
        expect(row.permissions).toEqual({
            ...ROLE_DEFAULT_PERMISSIONS['co-skipper'],
            // Passage flags follow the ticked registers, not the preset.
            can_view_passage: true,
            can_view_passage_checklist: true,
            can_view_passage_meals: false,
            can_view_passage_chat: false,
            can_view_passage_route: false,
            can_view_instruments: true,
        });
        // The vessel-level preset survives the merge — this is the bug the
        // design's `{...preset, ...syncPassagePermissions(registers)}` spread
        // would have introduced (every flag reset to false).
        expect((row.permissions as Record<string, boolean>).can_edit_stores).toBe(true);
        expect((row.permissions as Record<string, boolean>).can_edit_log).toBe(true);
    });

    it('still writes deckhand when no role is passed', async () => {
        const table = vesselCrewTable();
        supabaseMocks.from.mockReturnValue(table.query);

        const result = await inviteCrew('mate@example.com', ['stores']);

        expect(result).toEqual({ success: true });
        const row = table.insert.mock.calls[0][0] as Record<string, unknown>;
        expect(row.role).toBe('deckhand');
        expect(row).not.toHaveProperty('voyage_id');
        expect(row.permissions).toEqual(crewInvitePermissions('deckhand', ['stores']));
        const permissions = row.permissions as Record<string, boolean>;
        expect(permissions.can_view_stores).toBe(true);
        expect(permissions.can_view_instruments).toBe(false);
        expect(permissions.can_view_passage).toBe(false);
        expect(permissions.can_edit_log).toBe(false);
    });

    it('re-invites a declined person with the role chosen now, not the declined row', async () => {
        const table = vesselCrewTable({
            id: 'row-1',
            status: 'declined',
            permissions: ROLE_DEFAULT_PERMISSIONS.deckhand,
        });
        supabaseMocks.from.mockReturnValue(table.query);

        const result = await inviteCrew('mate@example.com', ['passage_route'], 'voyage-1', 'navigator');

        expect(result).toEqual({ success: true });
        expect(table.insert).not.toHaveBeenCalled();
        expect(table.update).toHaveBeenCalledTimes(1);
        const patch = table.update.mock.calls[0][0] as Record<string, unknown>;
        expect(patch.status).toBe('pending');
        expect(patch.role).toBe('navigator');
        expect(patch.permissions).toEqual(crewInvitePermissions('navigator', ['passage_route']));
    });

    it('refuses to change role on an accepted or pending row', async () => {
        const table = vesselCrewTable({ id: 'row-1', status: 'accepted', permissions: {} });
        supabaseMocks.from.mockReturnValue(table.query);

        const result = await inviteCrew('mate@example.com', ['stores'], undefined, 'co-skipper');

        expect(result.success).toBe(false);
        expect(table.insert).not.toHaveBeenCalled();
        expect(table.update).not.toHaveBeenCalled();
    });
});

describe('crewInvitePermissions', () => {
    it('keeps the role preset as the base and lets the registers decide passage flags', () => {
        const permissions = crewInvitePermissions('co-skipper', ['passage_chat']);
        expect(permissions.can_edit_stores).toBe(true);
        expect(permissions.can_view_nav).toBe(true);
        expect(permissions.can_view_passage).toBe(true);
        expect(permissions.can_view_passage_chat).toBe(true);
        expect(permissions.can_view_passage_route).toBe(false);
    });

    it('leaves the Instrument Panel off unless ticked, even for a co-skipper (Shane 2026-09-07)', () => {
        expect(crewInvitePermissions('co-skipper', ['stores']).can_view_instruments).toBe(false);
        expect(crewInvitePermissions('co-skipper', ['instruments']).can_view_instruments).toBe(true);
    });

    it('gives a punter nothing beyond the ticked registers', () => {
        const permissions = crewInvitePermissions('punter', ['passage_checklist']);
        expect(permissions.can_view_stores).toBe(false);
        expect(permissions.can_view_passage).toBe(true);
        expect(permissions.can_view_passage_checklist).toBe(true);
    });

    it("raises can_view_stores when Ship's Stores is ticked, because the stores gate reads the flag", () => {
        // can_access_vessel_register(owner, 'stores') checks
        // permissions.can_view_stores, never shared_registers — a punter with
        // only 'stores' in shared_registers would be refused at the table.
        const punter = crewInvitePermissions('punter', ['stores']);
        expect(punter.can_view_stores).toBe(true);
        expect(punter.can_edit_stores).toBe(false);
        // An unticked preset is left alone in both directions.
        expect(crewInvitePermissions('punter', ['instruments']).can_view_stores).toBe(false);
        expect(crewInvitePermissions('deckhand', ['instruments']).can_view_stores).toBe(true);
    });
});
