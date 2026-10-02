/**
 * Engine hours as shared R&M data (Shane, 2026-10-02: "the engine hours are
 * not going across to the invitee"). The reading was one device's
 * localStorage; it is now one synced row per skipper, read through the R&M
 * binder on show. Until the server table is live on a device, nothing changes.
 * No real accounts: 'skipper-1', 'crew-1', 'Test Boat'.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const db = vi.hoisted(() => {
    const tables = new Map<string, Map<string, Record<string, unknown>>>();
    const table = (name: string) => {
        if (!tables.has(name)) tables.set(name, new Map());
        return tables.get(name)!;
    };
    return {
        tables,
        table,
        outbox: [] as { type: 'INSERT' | 'UPDATE'; table: string; id: string; payload: Record<string, unknown> }[],
        meta: {} as Record<string, unknown>,
        identity: null as string | null,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getLocalDatabaseSession: () => ({ identity: db.identity, generation: 1 }),
    getSyncMeta: () => ({ ...db.meta }),
    getById: (name: string, id: string) => db.table(name).get(id) ?? null,
    query: (name: string, predicate: (row: Record<string, unknown>) => boolean) =>
        [...db.table(name).values()].filter(predicate),
    insertLocal: vi.fn(async (name: string, record: Record<string, unknown>) => {
        db.table(name).set(record.id as string, record);
        db.outbox.push({ type: 'INSERT', table: name, id: record.id as string, payload: record });
        return record;
    }),
    updateLocal: vi.fn(async (name: string, id: string, updates: Record<string, unknown>) => {
        const existing = db.table(name).get(id);
        if (!existing) return null;
        const next = { ...existing, ...updates, updated_at: new Date().toISOString() };
        db.table(name).set(id, next);
        db.outbox.push({ type: 'UPDATE', table: name, id, payload: updates });
        return next;
    }),
}));

import {
    ENGINE_HOURS_TABLE,
    LocalEngineHoursService,
    engineHoursRowId,
    isEngineHoursTableLive,
} from '../services/vessel/LocalEngineHoursService';
import { reloadSharedBindersFromStorage, SharedBinderReadOnlyError } from '../services/vessel/sharedBinders';

const LIVE = { optionalTablesReadAt: { [ENGINE_HOURS_TABLE]: '2026-10-02T09:00:00.000Z' } };

function signIn(userId: string) {
    setAuthIdentityScope(null);
    const scope = setAuthIdentityScope(userId);
    db.identity = userId;
    return scope;
}

/** The share snapshot sharedBinders reads; `maintenance` write as given. */
function crewOnSkipper(write = true, confirmed = true) {
    localStorage.setItem(
        'thalassa_shared_binders_v1::user%3Acrew-1',
        JSON.stringify({
            version: 1,
            userId: 'crew-1',
            confirmedAt: confirmed ? '2026-10-02T00:00:00.000Z' : null,
            skippers: [
                {
                    ownerId: 'skipper-1',
                    vesselName: 'Test Boat',
                    lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                    registers: {
                        stores: { read: false, write: false },
                        equipment: { read: false, write: false },
                        maintenance: { read: true, write },
                        documents: { read: false, write: false },
                    },
                },
            ],
        }),
    );
    reloadSharedBindersFromStorage();
}

/** The skipper's own share snapshot: confirmed, crewing for nobody. */
function ownBinderConfirmed(userId: string, confirmed = true) {
    localStorage.setItem(
        `thalassa_shared_binders_v1::user%3A${userId}`,
        JSON.stringify({
            version: 1,
            userId,
            confirmedAt: confirmed ? '2026-10-02T00:00:00.000Z' : null,
            skippers: [],
        }),
    );
    reloadSharedBindersFromStorage();
}

async function skipperRow(hours: number) {
    const id = await engineHoursRowId('skipper-1');
    db.table(ENGINE_HOURS_TABLE).set(id, {
        id,
        user_id: 'skipper-1',
        hours,
        created_at: '2026-10-02T08:00:00.000Z',
        updated_at: '2026-10-02T08:00:00.000Z',
    });
    return id;
}

beforeEach(() => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    db.tables.clear();
    db.outbox.length = 0;
    db.meta = {};
    db.identity = null;
    vi.clearAllMocks();
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.unstubAllGlobals();
});

describe('before the shared table is live on this device', () => {
    it('reads and writes this device’s own figure exactly as before, and queues nothing', async () => {
        const scope = signIn('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '1180');
        expect(isEngineHoursTableLive(scope)).toBe(false);
        expect(LocalEngineHoursService.getReading(scope)).toEqual({
            hours: 1180,
            source: 'device',
            skipper: false,
            canEdit: true,
        });

        await LocalEngineHoursService.setReading(1200, scope);
        expect(localStorage.getItem(authScopedStorageKey('thalassa_engine_hours', scope))).toBe('1200');
        expect(db.outbox).toEqual([]);
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);
    });

    it('is not live while the local database belongs to another account', () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        db.identity = 'someone-else';
        expect(isEngineHoursTableLive(scope)).toBe(false);
    });
});

describe('once the table is live', () => {
    it('saves the skipper’s reading as one row: INSERT, then the UPDATE that wins over a row another device made', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');

        await LocalEngineHoursService.setReading(1250, scope);
        const id = await engineHoursRowId('skipper-1');
        expect(db.outbox.map((entry) => [entry.type, entry.table, entry.id])).toEqual([
            ['INSERT', ENGINE_HOURS_TABLE, id],
            ['UPDATE', ENGINE_HOURS_TABLE, id],
        ]);
        expect(db.outbox[0].payload).toMatchObject({ id, user_id: 'skipper-1', hours: 1250 });
        expect(db.outbox[1].payload).toEqual({ hours: 1250 });
        expect(LocalEngineHoursService.getReading(scope)).toEqual({
            hours: 1250,
            source: 'shared',
            skipper: false,
            canEdit: true,
        });

        // A later edit is an UPDATE of that same row.
        db.outbox.length = 0;
        await LocalEngineHoursService.setReading(1262, scope);
        expect(db.outbox.map((entry) => [entry.type, entry.id, entry.payload])).toEqual([
            ['UPDATE', id, { hours: 1262 }],
        ]);
    });

    it('crew on the skipper’s shared R&M see and edit HIS reading, never their own figure', async () => {
        const scope = signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper();
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '7');
        const id = await skipperRow(1250);

        expect(LocalEngineHoursService.getReading(scope)).toEqual({
            hours: 1250,
            source: 'shared',
            skipper: true,
            canEdit: true,
        });

        await LocalEngineHoursService.setReading(1300, scope);
        expect(db.outbox).toEqual([{ type: 'UPDATE', table: ENGINE_HOURS_TABLE, id, payload: { hours: 1300 } }]);
        expect(db.table(ENGINE_HOURS_TABLE).get(id)).toMatchObject({ user_id: 'skipper-1', hours: 1300 });
        // The crew member's own device figure is left alone.
        expect(localStorage.getItem(authScopedStorageKey('thalassa_engine_hours', scope))).toBe('7');
    });

    it('a skipper with no reading yet reads "not set" to his crew, and crew who may edit R&M create it as his', async () => {
        const scope = signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper();
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '7');
        expect(LocalEngineHoursService.getReading(scope).hours).toBeNull();

        await LocalEngineHoursService.setReading(1250, scope);
        expect(db.outbox[0]).toMatchObject({ type: 'INSERT', payload: { user_id: 'skipper-1', hours: 1250 } });
        expect(db.outbox[0].id).toBe(await engineHoursRowId('skipper-1'));
    });

    it('a view-only share shows the reading, refuses an edit and queues nothing', async () => {
        const scope = signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper(false);
        await skipperRow(1250);

        expect(LocalEngineHoursService.getReading(scope)).toMatchObject({ hours: 1250, canEdit: false });
        await expect(LocalEngineHoursService.setReading(1300, scope)).rejects.toBeInstanceOf(SharedBinderReadOnlyError);
        expect(db.outbox).toEqual([]);
    });

    it('refuses a figure that is not a whole number of hours in range', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) {
            await expect(LocalEngineHoursService.setReading(bad, scope)).rejects.toBeInstanceOf(RangeError);
        }
        expect(db.outbox).toEqual([]);
    });
});

describe('the one-time carry-over of this device’s figure', () => {
    it('goes up once as an INSERT only, when the server has no reading for the skipper', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '1180');
        // Until it goes, the device figure stands in for the missing row.
        expect(LocalEngineHoursService.getReading(scope)).toMatchObject({ hours: 1180, source: 'shared' });

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        expect(db.outbox).toHaveLength(1);
        expect(db.outbox[0]).toMatchObject({
            type: 'INSERT',
            table: ENGINE_HOURS_TABLE,
            id: await engineHoursRowId('skipper-1'),
            payload: { user_id: 'skipper-1', hours: 1180 },
        });

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toHaveLength(1);
    });

    it('never overwrites a reading the server already has', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '900');
        await skipperRow(1250);

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);
        expect(LocalEngineHoursService.getReading(scope).hours).toBe(1250);
        // Settled for good: removing the row later does not bring 900 back up.
        db.tables.clear();
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);
    });

    it('raises a lower server reading once to this device’s higher figure: engine hours only go up', async () => {
        // The iPad (older 1200) synced first and created the row; the phone holds 1350.
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '1350');
        const id = await skipperRow(1200);

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        expect(db.outbox).toEqual([{ type: 'UPDATE', table: ENGINE_HOURS_TABLE, id, payload: { hours: 1350 } }]);
        expect(LocalEngineHoursService.getReading(scope).hours).toBe(1350);

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toHaveLength(1);
        // Settled: a later lower edit elsewhere is not raised again.
        db.table(ENGINE_HOURS_TABLE).set(id, { ...db.table(ENGINE_HOURS_TABLE).get(id), hours: 1340 });
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toHaveLength(1);
    });

    it('raises it only on the account’s own R&M once its shares are confirmed, and waits until then', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1', false);
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '1350');
        const id = await skipperRow(1200);

        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);

        ownBinderConfirmed('skipper-1');
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        expect(db.outbox).toEqual([{ type: 'UPDATE', table: ENGINE_HOURS_TABLE, id, payload: { hours: 1350 } }]);
    });

    it('when another device created the row at the same moment with a lower figure, the higher one still lands', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '1350');
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        const id = await engineHoursRowId('skipper-1');
        expect(db.outbox.map((entry) => entry.type)).toEqual(['INSERT']);

        // The server kept the iPad's INSERT (1200) and ignored this one; the
        // next pull brings that row over the now-clean local copy.
        db.outbox.length = 0;
        db.table(ENGINE_HOURS_TABLE).set(id, { ...db.table(ENGINE_HOURS_TABLE).get(id), hours: 1200 });
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        expect(db.outbox).toEqual([{ type: 'UPDATE', table: ENGINE_HOURS_TABLE, id, payload: { hours: 1350 } }]);
    });

    it('a figure typed before the table while showing a skipper’s shared R&M is never carried as the sailor’s own', async () => {
        const scope = signIn('crew-1');
        crewOnSkipper();
        await LocalEngineHoursService.setReading(4321, scope); // the skipper's boat, before the table
        expect(localStorage.getItem(authScopedStorageKey('thalassa_engine_hours', scope))).toBe('4321');
        expect(db.outbox).toEqual([]);

        // The share ends and the table goes live on this device.
        ownBinderConfirmed('crew-1');
        db.meta = LIVE;
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);
        // Nor does it stand in for the sailor's own (missing) reading.
        expect(LocalEngineHoursService.getReading(scope)).toMatchObject({ hours: null, source: 'shared' });
    });

    it('a figure typed before the table on the sailor’s own R&M is carried, even after one typed while crewing', async () => {
        const scope = signIn('crew-1');
        crewOnSkipper();
        await LocalEngineHoursService.setReading(4321, scope);
        ownBinderConfirmed('crew-1');
        await LocalEngineHoursService.setReading(85, scope); // their own boat now

        db.meta = LIVE;
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(true);
        expect(db.outbox).toEqual([
            expect.objectContaining({
                type: 'INSERT',
                payload: expect.objectContaining({ user_id: 'crew-1', hours: 85 }),
            }),
        ]);
    });

    it('waits while crewing a shared R&M, or before the shares are confirmed', async () => {
        const crew = signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper();
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', crew), '7');
        expect(await LocalEngineHoursService.carryOverDeviceReading(crew)).toBe(false);

        const skipper = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1', false);
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', skipper), '1180');
        expect(await LocalEngineHoursService.carryOverDeviceReading(skipper)).toBe(false);
        expect(db.outbox).toEqual([]);
    });

    it('a figure typed on the live table settles it: the old one never follows', async () => {
        const scope = signIn('skipper-1');
        db.meta = LIVE;
        ownBinderConfirmed('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', scope), '900');
        await LocalEngineHoursService.setReading(1250, scope);
        db.outbox.length = 0;
        db.tables.clear();
        expect(await LocalEngineHoursService.carryOverDeviceReading(scope)).toBe(false);
        expect(db.outbox).toEqual([]);
    });
});

describe('the row id', () => {
    it('is the same for the same skipper on every device, different per skipper, and not the user id', async () => {
        const a = await engineHoursRowId('skipper-1');
        expect(await engineHoursRowId('skipper-1')).toBe(a);
        expect(await engineHoursRowId('skipper-2')).not.toBe(a);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(a).not.toContain('skipper-1');
    });

    it('matches the id the database requires of the owner (vessel_engine_hours_row_id)', async () => {
        // A made-up owner. The same id came from the migration's SQL expression
        // on Postgres with pgcrypto (read-only SELECT, 2026-10-02); the table's
        // CHECK refuses any other id for this owner.
        expect(await engineHoursRowId('00000000-0000-4000-8000-000000000001')).toBe(
            '0c569ba4-8f18-8dad-b0d0-6ed8df8e30ac',
        );
    });
});
