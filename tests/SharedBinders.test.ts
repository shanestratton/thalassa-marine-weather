/**
 * Shared binders (Shane 2026-10-02): while a sailor is accepted crew on a
 * skipper's boat, each binder register the skipper shares shows the
 * skipper's rows. The share snapshot mirrors can_access_vessel_register
 * (20260723100000) exactly. No real accounts: 'skipper-1', 'crew-1', 'Test Boat'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const db = vi.hoisted(() => ({
    crewRows: [] as Record<string, unknown>[],
    crewError: null as { message: string } | null,
    vessels: [] as Record<string, unknown>[],
    vesselError: null as { message: string } | null,
    sessionIdentity: 'crew-1' as string | null,
    sessionCurrent: true,
    from: vi.fn(),
}));

function query(result: () => { data: unknown; error: unknown }) {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in']) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
    return builder;
}

vi.mock('../services/supabase', () => ({
    supabase: { from: db.from },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getLocalDatabaseSession: () => ({ identity: db.sessionIdentity, generation: 1 }),
    isLocalDatabaseSessionCurrent: () => db.sessionCurrent,
}));

import {
    assertBinderDeletable,
    assertBinderWritable,
    binderInsertOwner,
    binderRowFilter,
    binderWriteGranted,
    canSeedOwnBinder,
    deriveBinderAccess,
    getBinderSource,
    getSharedBindersState,
    listBinderSkippers,
    refreshSharedBinders,
    reloadSharedBindersFromStorage,
    selectBinderSkipper,
    SharedBinderReadOnlyError,
    subscribeSharedBinders,
} from '../services/vessel/sharedBinders';

const ALL_FLAGS_OFF = { can_view_stores: false, can_edit_stores: false };

function membership(ownerId: string, overrides: Record<string, unknown> = {}) {
    return {
        owner_id: ownerId,
        crew_user_id: 'crew-1',
        status: 'accepted',
        shared_registers: ['stores', 'equipment', 'maintenance'],
        permissions: { can_view_stores: true, can_edit_stores: true },
        updated_at: '2026-10-01T21:43:51.000Z',
        ...overrides,
    };
}

describe('deriveBinderAccess mirrors can_access_vessel_register', () => {
    it('reads stores from the JSONB flags only, never from shared_registers', () => {
        const [skipper] = deriveBinderAccess(
            [
                membership('skipper-1', {
                    shared_registers: ['stores', 'equipment'],
                    permissions: ALL_FLAGS_OFF,
                }),
            ],
            'crew-1',
        );
        // 'stores' in shared_registers grants nothing; the flags decide.
        expect(skipper.registers.stores).toEqual({ read: false, write: false });
        expect(skipper.registers.equipment).toEqual({ read: true, write: true });

        const [viewOnly] = deriveBinderAccess(
            [membership('skipper-1', { shared_registers: [], permissions: { can_view_stores: true } })],
            'crew-1',
        );
        expect(viewOnly.registers.stores).toEqual({ read: true, write: false });

        // can_edit_stores alone implies read, as `view OR edit` does.
        const [editOnly] = deriveBinderAccess(
            [membership('skipper-1', { shared_registers: [], permissions: { can_edit_stores: 'true' } })],
            'crew-1',
        );
        expect(editOnly.registers.stores).toEqual({ read: true, write: true });
    });

    it('gives equipment, maintenance and documents read = write = ticked (no view-only form)', () => {
        const [skipper] = deriveBinderAccess(
            [membership('skipper-1', { shared_registers: ['documents'], permissions: {} })],
            'crew-1',
        );
        expect(skipper.registers.documents).toEqual({ read: true, write: true });
        expect(skipper.registers.maintenance).toEqual({ read: false, write: false });
        expect(skipper.registers.equipment).toEqual({ read: false, write: false });
    });

    it('ignores voyage_id, unions several rows per skipper, and skips non-accepted rows', () => {
        const skippers = deriveBinderAccess(
            [
                membership('skipper-1', {
                    voyage_id: 'voyage-a',
                    shared_registers: ['equipment'],
                    permissions: ALL_FLAGS_OFF,
                }),
                membership('skipper-1', {
                    voyage_id: 'voyage-b',
                    shared_registers: ['maintenance'],
                    permissions: { can_view_stores: true },
                    updated_at: '2026-10-02T01:00:00.000Z',
                }),
                membership('skipper-2', { status: 'pending' }),
                membership('crew-1'),
            ],
            'crew-1',
        );
        expect(skippers).toHaveLength(1);
        expect(skippers[0].registers.equipment.write).toBe(true);
        expect(skippers[0].registers.maintenance.write).toBe(true);
        expect(skippers[0].registers.stores).toEqual({ read: true, write: false });
        expect(skippers[0].lastAcceptedAt).toBe('2026-10-02T01:00:00.000Z');
    });

    it('leaves out a skipper who shares no binder register (instruments only)', () => {
        expect(
            deriveBinderAccess(
                [membership('skipper-1', { shared_registers: ['instruments'], permissions: ALL_FLAGS_OFF })],
                'crew-1',
            ),
        ).toEqual([]);
    });
});

describe('shared binder snapshot', () => {
    beforeEach(() => {
        localStorage.clear();
        db.crewRows = [membership('skipper-1')];
        db.crewError = null;
        db.vessels = [{ owner_id: 'skipper-1', vessel_name: 'Test Boat' }];
        db.vesselError = null;
        db.sessionIdentity = 'crew-1';
        db.sessionCurrent = true;
        db.from.mockReset();
        db.from.mockImplementation((table: string) =>
            table === 'vessel_crew'
                ? query(() => ({ data: db.crewError ? null : db.crewRows, error: db.crewError }))
                : query(() => ({ data: db.vesselError ? null : db.vessels, error: db.vesselError })),
        );
        setAuthIdentityScope(null);
        setAuthIdentityScope('crew-1');
        reloadSharedBindersFromStorage();
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it('a user with no accepted memberships keeps the own binder exactly as today (A10)', async () => {
        db.crewRows = [];
        const result = await refreshSharedBinders();
        expect(result).toEqual({ changed: false, fresh: true });
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
        expect(binderInsertOwner('stores')).toBe('crew-1');
        expect(binderRowFilter('stores')({ user_id: 'crew-1' })).toBe(true);
        expect(binderRowFilter('stores')({ user_id: '' })).toBe(true);
        expect(canSeedOwnBinder('maintenance')).toBe(true);
        expect(() => assertBinderDeletable('stores', { user_id: 'crew-1' })).not.toThrow();
    });

    it("shows the skipper's binder with the boat's name, stamps adds with the skipper's id (A1/A2/A3)", async () => {
        const result = await refreshSharedBinders();
        expect(result).toEqual({ changed: true, fresh: true });
        expect(getBinderSource('maintenance')).toEqual({
            mode: 'shared',
            ownerId: 'skipper-1',
            vesselName: 'Test Boat',
            canWrite: true,
            canDelete: false,
            skipperCount: 1,
        });
        const inBinder = binderRowFilter('maintenance');
        expect(inBinder({ user_id: 'skipper-1' })).toBe(true);
        expect(inBinder({ user_id: 'crew-1' })).toBe(false);
        expect(inBinder({ user_id: '' })).toBe(false);
        expect(binderInsertOwner('maintenance')).toBe('skipper-1');
        // Documents are not shared by this skipper: the crew's own binder.
        expect(getBinderSource('documents')).toEqual({ mode: 'own' });
        expect(canSeedOwnBinder('maintenance')).toBe(false);
    });

    it('falls back to "your skipper\'s boat" when the boat name cannot be read, and never fails for it', async () => {
        db.vesselError = { message: 'permission denied' };
        await refreshSharedBinders();
        const source = getBinderSource('stores');
        expect(source.mode === 'shared' && source.vesselName).toBe(null);
    });

    it('a view-only stores share refuses adds, edits and deletes before anything is queued (A4)', async () => {
        db.crewRows = [membership('skipper-1', { shared_registers: [], permissions: { can_view_stores: true } })];
        await refreshSharedBinders();
        const source = getBinderSource('stores');
        expect(source).toMatchObject({ mode: 'shared', canWrite: false });
        expect(() => binderInsertOwner('stores')).toThrow(SharedBinderReadOnlyError);
        expect(() => assertBinderWritable('stores', { user_id: 'skipper-1' })).toThrow(SharedBinderReadOnlyError);
        expect(() => assertBinderDeletable('stores', { user_id: 'skipper-1' })).toThrow(SharedBinderReadOnlyError);
        // The crew's own (hidden) rows stay theirs.
        expect(() => assertBinderWritable('stores', { user_id: 'crew-1' })).not.toThrow();
    });

    it("never deletes from a skipper's binder, even with write (A5)", async () => {
        await refreshSharedBinders();
        expect(() => assertBinderWritable('maintenance', { user_id: 'skipper-1' })).not.toThrow();
        expect(() => assertBinderDeletable('maintenance', { user_id: 'skipper-1' })).toThrow(SharedBinderReadOnlyError);
    });

    it('throws on a query error and keeps the cached snapshot (A8)', async () => {
        await refreshSharedBinders();
        const before = getSharedBindersState();
        db.crewError = { message: 'network down' };
        await expect(refreshSharedBinders()).rejects.toThrow('network down');
        expect(getSharedBindersState()).toBe(before);
        expect(getBinderSource('stores')).toMatchObject({ mode: 'shared', ownerId: 'skipper-1' });
    });

    it('reports changed only when a share, a register or the effective skipper changes (A7)', async () => {
        expect((await refreshSharedBinders()).changed).toBe(true);
        expect((await refreshSharedBinders()).changed).toBe(false);
        db.vessels = [{ owner_id: 'skipper-1', vessel_name: 'Renamed Boat' }];
        expect((await refreshSharedBinders()).changed).toBe(false);
        db.crewRows = [membership('skipper-1', { shared_registers: ['stores'] })];
        expect((await refreshSharedBinders()).changed).toBe(true);
        db.crewRows = [];
        expect((await refreshSharedBinders()).changed).toBe(true);
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
    });

    it('notifies subscribers on a visible change, not on a quiet re-confirmation', async () => {
        const listener = vi.fn();
        const off = subscribeSharedBinders(listener);
        await refreshSharedBinders();
        expect(listener).toHaveBeenCalledTimes(1);
        await refreshSharedBinders();
        expect(listener).toHaveBeenCalledTimes(1);
        off();
    });

    it('refuses to run for a stale or mismatched local database session', async () => {
        db.sessionIdentity = 'someone-else';
        await expect(refreshSharedBinders()).rejects.toThrow();
        db.sessionIdentity = 'crew-1';
        db.sessionCurrent = false;
        await expect(refreshSharedBinders()).rejects.toThrow();
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
    });

    it('two skippers: newest membership by default, Switch boat persists per account (A9)', async () => {
        db.crewRows = [
            membership('skipper-1', { updated_at: '2026-10-01T00:00:00.000Z' }),
            membership('skipper-2', { updated_at: '2026-10-02T00:00:00.000Z' }),
        ];
        db.vessels = [
            { owner_id: 'skipper-1', vessel_name: 'Test Boat' },
            { owner_id: 'skipper-2', vessel_name: 'Other Boat' },
        ];
        await refreshSharedBinders();
        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-2', skipperCount: 2 });
        expect(binderInsertOwner('stores')).toBe('skipper-2');
        expect(binderRowFilter('stores')({ user_id: 'skipper-1' })).toBe(false);
        expect(listBinderSkippers('stores').map((skipper) => skipper.vesselName)).toEqual(['Other Boat', 'Test Boat']);

        selectBinderSkipper('skipper-1');
        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-1' });
        expect(binderInsertOwner('stores')).toBe('skipper-1');

        // Persisted for this account across a reload.
        reloadSharedBindersFromStorage();
        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-1' });
        // A skipper outside the snapshot cannot be selected.
        selectBinderSkipper('stranger');
        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-1' });
    });

    it('a roster edit does not switch the default boat: newest membership by when it began', async () => {
        // skipper-1's older membership was just edited (updateCrewPermissions
        // bumps updated_at); skipper-2's is newer. The default stays skipper-2.
        db.crewRows = [
            membership('skipper-1', { created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-10-02T09:00:00.000Z' }),
            membership('skipper-2', { created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z' }),
        ];
        db.vessels = [];
        await refreshSharedBinders();
        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-2', skipperCount: 2 });
        expect(listBinderSkippers('stores').map((skipper) => skipper.ownerId)).toEqual(['skipper-2', 'skipper-1']);
    });

    it('ties on the membership time are broken by owner id, so every device agrees', async () => {
        db.crewRows = [membership('skipper-b'), membership('skipper-a')];
        db.vessels = [];
        await refreshSharedBinders();
        expect(getBinderSource('equipment')).toMatchObject({ ownerId: 'skipper-a' });
    });

    it('a register the selected skipper does not share falls to the other skipper who does, never a mix', async () => {
        db.crewRows = [
            membership('skipper-1', { shared_registers: ['equipment'], permissions: ALL_FLAGS_OFF }),
            membership('skipper-2', {
                shared_registers: ['maintenance'],
                permissions: ALL_FLAGS_OFF,
                updated_at: '2026-09-01T00:00:00.000Z',
            }),
        ];
        await refreshSharedBinders();
        selectBinderSkipper('skipper-1');
        expect(getBinderSource('equipment')).toMatchObject({ ownerId: 'skipper-1' });
        expect(getBinderSource('maintenance')).toMatchObject({ ownerId: 'skipper-2', skipperCount: 1 });
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
    });

    it('writes are granted per skipper and register, from the snapshot', async () => {
        db.crewRows = [membership('skipper-1', { shared_registers: ['equipment'], permissions: ALL_FLAGS_OFF })];
        await refreshSharedBinders();
        expect(binderWriteGranted('equipment', 'skipper-1')).toBe(true);
        expect(binderWriteGranted('maintenance', 'skipper-1')).toBe(false);
        expect(binderWriteGranted('maintenance', 'crew-1')).toBe(true);
        expect(binderWriteGranted('stores', 'stranger')).toBe(false);
    });

    it('offline with a cached snapshot the binder stays shared; a cold start with no cache is own (A14)', async () => {
        await refreshSharedBinders();
        // A later launch, offline: no refresh, only what is cached.
        reloadSharedBindersFromStorage();
        expect(getBinderSource('stores')).toMatchObject({ mode: 'shared', ownerId: 'skipper-1' });
        expect(binderInsertOwner('stores')).toBe('skipper-1');

        localStorage.clear();
        reloadSharedBindersFromStorage();
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
        // ...and nothing seeds until the server has confirmed once (A12).
        expect(canSeedOwnBinder('maintenance')).toBe(false);
    });

    it('an account switch never shows the previous account its snapshot or selection (A11)', async () => {
        await refreshSharedBinders();
        expect(getBinderSource('stores')).toMatchObject({ mode: 'shared' });
        const keys = Object.keys(localStorage).filter((key) => key.startsWith('thalassa_shared_binder'));
        expect(keys).toContain('thalassa_shared_binders_v1::user%3Acrew-1');
        // Every key carries the account suffix the deletion sweep removes.
        expect(keys.every((key) => key.endsWith('::user%3Acrew-1'))).toBe(true);

        setAuthIdentityScope('other-1');
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
        expect(binderInsertOwner('stores')).toBe('other-1');
        expect(canSeedOwnBinder('maintenance')).toBe(false);

        // A snapshot stored under one account is never read for another.
        localStorage.setItem(
            'thalassa_shared_binders_v1::user%3Aother-1',
            localStorage.getItem('thalassa_shared_binders_v1::user%3Acrew-1')!,
        );
        reloadSharedBindersFromStorage();
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });

        setAuthIdentityScope(null);
        expect(getBinderSource('stores')).toEqual({ mode: 'own' });
        expect(binderInsertOwner('stores')).toBe('');
        expect(canSeedOwnBinder('maintenance')).toBe(true);
        // Signed out, every local row is the sailor's (unchanged behaviour).
        expect(binderRowFilter('stores')({ user_id: 'anyone' })).toBe(true);
    });
});
