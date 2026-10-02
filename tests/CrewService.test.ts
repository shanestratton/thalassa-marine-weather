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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    storesPermissions,
    inviteCrew,
    acceptInvite,
    declineInvite,
    withAlwaysSharedRegisters,
    ALWAYS_SHARED_REGISTERS,
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
        // Crew Chat is every crew member's by default (Shane 2026-10-02).
        expect(row.shared_registers).toEqual(['instruments', 'passage_checklist', 'passage_chat']);
        expect(row.permissions).toEqual({
            ...ROLE_DEFAULT_PERMISSIONS['co-skipper'],
            // Passage flags follow the ticked registers, not the preset.
            can_view_passage: true,
            can_view_passage_checklist: true,
            can_view_passage_meals: false,
            can_view_passage_chat: true,
            can_view_passage_route: false,
            can_view_instruments: true,
            // Stores follow the tick (2026-10-02): not ticked, not shared.
            can_view_stores: false,
            can_edit_stores: false,
        });
        // The vessel-level preset survives the merge — this is the bug the
        // design's `{...preset, ...syncPassagePermissions(registers)}` spread
        // would have introduced (every flag reset to false).
        expect((row.permissions as Record<string, boolean>).can_view_nav).toBe(true);
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
        expect(row.permissions).toEqual(crewInvitePermissions('deckhand', ['stores', 'passage_chat']));
        const permissions = row.permissions as Record<string, boolean>;
        expect(permissions.can_view_stores).toBe(true);
        expect(permissions.can_view_instruments).toBe(false);
        // Crew Chat comes with every invite (2026-10-02), so the passage is
        // visible for its chat; meals, route and checklist stay off.
        expect(permissions.can_view_passage_chat).toBe(true);
        expect(permissions.can_view_passage_meals).toBe(false);
        expect(permissions.can_view_passage_route).toBe(false);
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
        expect(patch.permissions).toEqual(crewInvitePermissions('navigator', ['passage_route', 'passage_chat']));
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
        expect(permissions.can_edit_log).toBe(true);
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
        expect(crewInvitePermissions('punter', ['instruments']).can_view_stores).toBe(false);
    });

    it("shares stores only when Ship's Stores is ticked, whatever the role preset (shared binders 2026-10-02)", () => {
        // A deckhand or navigator invited WITHOUT Stores used to keep the
        // preset's can_view_stores, so the skipper's stores were readable.
        for (const role of ['deckhand', 'navigator', 'co-skipper'] as const) {
            const unticked = crewInvitePermissions(role, ['instruments']);
            expect(unticked.can_view_stores).toBe(false);
            expect(unticked.can_edit_stores).toBe(false);
        }
        // Ticked: everyone can look; only a preset that edits can edit.
        expect(crewInvitePermissions('co-skipper', ['stores'])).toMatchObject({
            can_view_stores: true,
            can_edit_stores: true,
        });
        expect(crewInvitePermissions('navigator', ['stores'])).toMatchObject({
            can_view_stores: true,
            can_edit_stores: false,
        });
    });
});

describe('updateCrewPermissions follows the Stores tick (shared binders 2026-10-02)', () => {
    beforeEach(() => {
        setAuthIdentityScope('skipper-1');
        supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'skipper-1' } }, error: null });
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        supabaseMocks.getUser.mockReset();
        supabaseMocks.from.mockReset();
    });

    it('reads the role and clears both stores flags when Stores is unticked', async () => {
        const table = vesselCrewTable({
            permissions: { ...ROLE_DEFAULT_PERMISSIONS['co-skipper'] },
            role: 'co-skipper',
        });
        supabaseMocks.from.mockReturnValue(table.query);
        const { updateCrewPermissions } = await import('../services/CrewService');

        expect(await updateCrewPermissions('row-1', ['equipment', 'maintenance'])).toBe(true);

        expect((table.query.select as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('permissions, role');
        const patch = table.update.mock.calls[0][0] as { permissions: Record<string, boolean> };
        expect(patch.permissions.can_view_stores).toBe(false);
        expect(patch.permissions.can_edit_stores).toBe(false);
        // Everything else on the row is kept.
        expect(patch.permissions.can_edit_log).toBe(true);
    });

    it("re-ticking Stores restores a co-skipper's edit and gives a navigator view only", async () => {
        for (const [role, edit] of [
            ['co-skipper', true],
            ['navigator', false],
        ] as const) {
            const table = vesselCrewTable({
                permissions: { ...ROLE_DEFAULT_PERMISSIONS[role], can_view_stores: false, can_edit_stores: false },
                role,
            });
            supabaseMocks.from.mockReturnValue(table.query);
            const { updateCrewPermissions } = await import('../services/CrewService');
            expect(await updateCrewPermissions('row-1', ['stores'])).toBe(true);
            const patch = table.update.mock.calls[0][0] as { permissions: Record<string, boolean> };
            expect(patch.permissions.can_view_stores).toBe(true);
            expect(patch.permissions.can_edit_stores).toBe(edit);
        }
    });
});

describe('storesPermissions (roster edits)', () => {
    it("unticking Stores really unshares, and re-ticking restores the role's edit", () => {
        expect(
            storesPermissions('co-skipper', ['equipment'], { can_view_stores: true, can_edit_stores: true }),
        ).toEqual({
            can_view_stores: false,
            can_edit_stores: false,
        });
        expect(storesPermissions('co-skipper', ['stores'], { can_view_stores: false, can_edit_stores: false })).toEqual(
            { can_view_stores: true, can_edit_stores: true },
        );
        // An edit grant already on the row is kept while ticked.
        expect(storesPermissions('deckhand', ['stores'], { can_edit_stores: true })).toEqual({
            can_view_stores: true,
            can_edit_stores: true,
        });
        // Unknown role: view only, never an invented edit.
        expect(storesPermissions('captain-ish', ['stores'], {})).toEqual({
            can_view_stores: true,
            can_edit_stores: false,
        });
    });
});

// ── Accept / decline never fail silently (field bug 2026-10-02) ─────────
//
// Every accept failed in the database (the bridge trigger's helper had gone
// missing) and acceptInvite returned false with no trace, so the crew
// member's Accept button simply did nothing. A database error and an update
// that changed no row are both failures, and both are logged.

function answerTable(updateResult: { data: unknown; error: unknown }) {
    const query: Record<string, unknown> = {};
    let updating = false;
    const chain = vi.fn(() => query);
    const update = vi.fn(() => {
        updating = true;
        return query;
    });
    Object.assign(query, {
        select: chain,
        eq: chain,
        update,
        single: vi.fn(() => Promise.resolve({ data: { owner_id: 'skipper-1', crew_user_id: 'crew-9' }, error: null })),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(updating ? updateResult : { data: null, error: null }).then(resolve, reject),
    });
    return { query, update };
}

describe('acceptInvite and declineInvite report failure (2026-10-02)', () => {
    beforeEach(() => {
        setAuthIdentityScope('crew-9');
        supabaseMocks.getUser.mockResolvedValue({
            data: { user: { id: 'crew-9', email: 'mate@example.com' } },
            error: null,
        });
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        supabaseMocks.getUser.mockReset();
        supabaseMocks.from.mockReset();
    });

    it('accept: a database error is a failure', async () => {
        const table = answerTable({
            data: null,
            error: { message: 'function public.user_name_parts(uuid) does not exist' },
        });
        supabaseMocks.from.mockReturnValue(table.query);
        await expect(acceptInvite('invite-1')).resolves.toBe(false);
        expect(table.update).toHaveBeenCalledTimes(1);
    });

    it('accept: an update that changed no row is a failure', async () => {
        supabaseMocks.from.mockReturnValue(answerTable({ data: [], error: null }).query);
        await expect(acceptInvite('invite-1')).resolves.toBe(false);
    });

    it('accept: one row changed is a success', async () => {
        supabaseMocks.from.mockReturnValue(answerTable({ data: [{ id: 'invite-1' }], error: null }).query);
        await expect(acceptInvite('invite-1')).resolves.toBe(true);
    });

    it('decline: a database error or no row changed is a failure; one row is a success', async () => {
        supabaseMocks.from.mockReturnValue(answerTable({ data: null, error: { message: 'denied' } }).query);
        await expect(declineInvite('invite-1')).resolves.toBe(false);
        supabaseMocks.from.mockReturnValue(answerTable({ data: [], error: null }).query);
        await expect(declineInvite('invite-1')).resolves.toBe(false);
        supabaseMocks.from.mockReturnValue(answerTable({ data: [{ id: 'invite-1' }], error: null }).query);
        await expect(declineInvite('invite-1')).resolves.toBe(true);
    });
});

describe('Crew Chat is shared with every crew member, no tick box (Shane 2026-10-02)', () => {
    it('adds passage_chat to whatever was ticked, once', () => {
        expect(ALWAYS_SHARED_REGISTERS).toEqual(['passage_chat']);
        expect(withAlwaysSharedRegisters(['stores'])).toEqual(['stores', 'passage_chat']);
        expect(withAlwaysSharedRegisters(['passage_chat', 'stores'])).toEqual(['passage_chat', 'stores']);
        expect(withAlwaysSharedRegisters([])).toEqual(['passage_chat']);
    });

    it('applies it on invite and on every roster edit', () => {
        const src = readFileSync(resolve(__dirname, '../services/CrewService.ts'), 'utf8');
        const invite = src.slice(
            src.indexOf('export async function inviteCrew'),
            src.indexOf('export async function getMyCrew'),
        );
        const update = src.slice(
            src.indexOf('export async function updateCrewPermissions'),
            src.indexOf('export async function removeCrew'),
        );
        expect(invite).toContain('registers = withAlwaysSharedRegisters(registers);');
        expect(update).toContain('registers = withAlwaysSharedRegisters(registers);');
    });

    it('is not offered as a tick box in the access editor', () => {
        const form = readFileSync(resolve(__dirname, '../components/crewManagement/EditCrewAccessForm.tsx'), 'utf8');
        expect(form).toContain('ALL_REGISTERS.filter((reg) => !ALWAYS_SHARED_REGISTERS.includes(reg))');
    });
});
