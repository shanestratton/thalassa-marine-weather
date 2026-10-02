/**
 * Shared binders at the Local*Service layer (2026-10-02). The local mirror
 * holds the crew's own rows AND the skipper's; every binder read shows one
 * owner, every add carries an explicit owner, and the share decides what may
 * be changed or deleted, before anything is queued.
 * No real accounts: 'skipper-1', 'crew-1', 'Test Boat'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

interface QueueEntry {
    table: string;
    id: string;
    type: 'INSERT' | 'UPDATE' | 'DELETE' | 'DELTA';
    payload: Record<string, unknown>;
}

const local = vi.hoisted(() => {
    const tables = new Map<string, Map<string, Record<string, unknown>>>();
    const queue: QueueEntry[] = [];
    let uuid = 0;
    const table = (name: string) => {
        if (!tables.has(name)) tables.set(name, new Map());
        return tables.get(name)!;
    };
    return {
        tables,
        queue,
        table,
        reset() {
            tables.clear();
            queue.length = 0;
            uuid = 0;
        },
        nextId: () => `local-${++uuid}`,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: (name: string) => [...local.table(name).values()],
    getById: (name: string, id: string) => local.table(name).get(id) ?? null,
    query: (name: string, predicate: (row: Record<string, unknown>) => boolean) =>
        [...local.table(name).values()].filter(predicate),
    insertLocal: vi.fn(async (name: string, record: Record<string, unknown>) => {
        local.table(name).set(String(record.id), record);
        local.queue.push({ table: name, id: String(record.id), type: 'INSERT', payload: { ...record } });
        return record;
    }),
    updateLocal: vi.fn(async (name: string, id: string, updates: Record<string, unknown>) => {
        const existing = local.table(name).get(id);
        if (!existing) return null;
        const updated = { ...existing, ...updates };
        local.table(name).set(id, updated);
        local.queue.push({ table: name, id, type: 'UPDATE', payload: { ...updates } });
        return updated;
    }),
    deltaLocal: vi.fn(async (name: string, id: string, field: string, delta: number) => {
        const existing = local.table(name).get(id);
        if (!existing) return null;
        const updated = { ...existing, [field]: Math.max(0, Number(existing[field]) + delta) };
        local.table(name).set(id, updated);
        local.queue.push({ table: name, id, type: 'DELTA', payload: { id, field, delta } });
        return updated;
    }),
    deleteLocal: vi.fn(async (name: string, id: string) => {
        if (!local.table(name).delete(id)) return;
        local.queue.push({ table: name, id, type: 'DELETE', payload: { id } });
    }),
    generateUUID: () => local.nextId(),
}));

vi.mock('../utils/dataChangeEvents', () => ({
    DATA_EVENTS: { MAINTENANCE: 'm', DOCUMENTS: 'd', EQUIPMENT: 'e' },
    dispatchDataChange: vi.fn(),
}));

import { LocalInventoryService } from '../services/vessel/LocalInventoryService';
import { LocalEquipmentService } from '../services/vessel/LocalEquipmentService';
import { LocalDocumentService } from '../services/vessel/LocalDocumentService';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { reloadSharedBindersFromStorage, SharedBinderReadOnlyError } from '../services/vessel/sharedBinders';
import type { EquipmentItem, InventoryItem, MaintenanceTask, ShipDocument } from '../types';

const SNAPSHOT_KEY = 'thalassa_shared_binders_v1::user%3Acrew-1';
const access = (read: boolean, write = read) => ({ read, write });

function share(registers: {
    stores?: { read: boolean; write: boolean };
    equipment?: boolean;
    maintenance?: boolean;
    documents?: boolean;
}) {
    localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({
            version: 1,
            userId: 'crew-1',
            confirmedAt: '2026-10-02T00:00:00.000Z',
            skippers: [
                {
                    ownerId: 'skipper-1',
                    vesselName: 'Test Boat',
                    lastAcceptedAt: '2026-10-01T21:43:51.000Z',
                    registers: {
                        stores: registers.stores ?? access(false),
                        equipment: access(!!registers.equipment),
                        maintenance: access(!!registers.maintenance),
                        documents: access(!!registers.documents),
                    },
                },
            ],
        }),
    );
    reloadSharedBindersFromStorage();
}

function confirmNoShares() {
    localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ version: 1, userId: 'crew-1', confirmedAt: '2026-10-02T00:00:00.000Z', skippers: [] }),
    );
    reloadSharedBindersFromStorage();
}

function stores(id: string, owner: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id,
        user_id: owner,
        barcode: null,
        item_name: 'Rice',
        description: null,
        category: 'Provisions',
        quantity: 2,
        min_quantity: 0,
        unit: 'kg',
        location_zone: 'Galley',
        location_specific: null,
        expiry_date: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        ...overrides,
    } as InventoryItem;
}

function task(id: string, owner: string, overrides: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: owner,
        title: 'Oil change',
        description: null,
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
        next_due_date: '2026-11-01',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: '2026-09-05T00:00:00.000Z',
        updated_at: '2026-09-05T00:00:00.000Z',
        ...overrides,
    };
}

function seedRows() {
    local.table('inventory_items').set('s-rice', stores('s-rice', 'skipper-1') as never);
    local.table('inventory_items').set('c-rice', stores('c-rice', 'crew-1') as never);
    local.table('maintenance_tasks').set('s-oil', task('s-oil', 'skipper-1') as never);
    local.table('maintenance_tasks').set('c-oil', task('c-oil', 'crew-1') as never);
    local.table('equipment_register').set('s-engine', {
        id: 's-engine',
        user_id: 'skipper-1',
        equipment_name: 'Main engine',
        make: '',
        model: '',
        serial_number: '',
        category: 'Propulsion',
    } as never);
    local.table('equipment_register').set('c-radio', {
        id: 'c-radio',
        user_id: 'crew-1',
        equipment_name: 'Handheld VHF',
        make: '',
        model: '',
        serial_number: '',
        category: 'Electronics',
    } as never);
    local.table('ship_documents').set('s-rego', {
        id: 's-rego',
        user_id: 'skipper-1',
        document_name: 'Registration',
        category: 'Registration',
    } as never);
    local.table('ship_documents').set('c-passport', {
        id: 'c-passport',
        user_id: 'crew-1',
        document_name: 'Passport',
        category: 'Crew',
    } as never);
}

describe('Local binder services while crew', () => {
    beforeEach(() => {
        local.reset();
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('crew-1');
        reloadSharedBindersFromStorage();
        seedRows();
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it("lists exactly the skipper's rows, and the crew's own stay in the mirror (A1)", () => {
        share({ stores: access(true), equipment: true, maintenance: true, documents: true });

        expect(LocalInventoryService.getAll().map((row) => row.id)).toEqual(['s-rice']);
        expect(LocalInventoryService.getItem('c-rice')).toBeNull();
        expect(LocalInventoryService.search('rice').map((row) => row.id)).toEqual(['s-rice']);
        expect(LocalInventoryService.getStats().totalItems).toBe(1);
        expect(LocalEquipmentService.getAll().map((row) => row.id)).toEqual(['s-engine']);
        expect(LocalDocumentService.getAll().map((row) => row.id)).toEqual(['s-rego']);
        expect(LocalMaintenanceService.getTasks().map((row) => row.id)).toEqual(['s-oil']);
        // Hidden, not gone: the crew's rows return when the share ends.
        expect(local.table('inventory_items').has('c-rice')).toBe(true);
        expect(local.table('maintenance_tasks').has('c-oil')).toBe(true);

        confirmNoShares();
        expect(LocalInventoryService.getAll().map((row) => row.id)).toEqual(['c-rice']);
        expect(LocalMaintenanceService.getTasks().map((row) => row.id)).toEqual(['c-oil']);
    });

    it("stamps an add in a shared binder with the skipper's id, in the row and the outbox (A3)", async () => {
        share({ stores: access(true), equipment: true, maintenance: true, documents: true });

        const created = await LocalMaintenanceService.createTask({
            title: 'Impeller',
            description: null,
            category: 'Engine',
            trigger_type: 'annual',
            interval_value: 365,
            next_due_date: null,
            next_due_hours: null,
            last_completed: null,
            is_active: true,
        });
        expect(created.user_id).toBe('skipper-1');
        expect(LocalMaintenanceService.getTasks().map((row) => row.id)).toContain(created.id);
        expect(local.queue.at(-1)).toMatchObject({ type: 'INSERT', payload: { user_id: 'skipper-1' } });

        const item = await LocalInventoryService.create(stores('ignored', '') as never);
        expect(item.user_id).toBe('skipper-1');
        const equipment = await LocalEquipmentService.create({
            equipment_name: 'Windlass',
        } as Omit<EquipmentItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>);
        expect(equipment.user_id).toBe('skipper-1');
        const doc = await LocalDocumentService.create({
            document_name: 'Insurance',
            category: 'Insurance',
        } as Omit<ShipDocument, 'id' | 'user_id' | 'created_at' | 'updated_at'>);
        expect(doc.user_id).toBe('skipper-1');
        expect(local.queue.filter((entry) => entry.type === 'INSERT').map((entry) => entry.payload.user_id)).toEqual([
            'skipper-1',
            'skipper-1',
            'skipper-1',
            'skipper-1',
        ]);
    });

    it('a view-only stores share refuses create, update and adjust, and queues nothing (A4)', async () => {
        share({ stores: access(true, false), maintenance: true });

        expect(LocalInventoryService.getAll().map((row) => row.id)).toEqual(['s-rice']);
        await expect(LocalInventoryService.create(stores('x', '') as never)).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalInventoryService.update('s-rice', { item_name: 'Brown rice' })).rejects.toThrow(
            SharedBinderReadOnlyError,
        );
        await expect(LocalInventoryService.adjustQuantity('s-rice', -1)).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalInventoryService.incrementQuantity('s-rice', 1)).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalInventoryService.decrementQuantity('s-rice', 1)).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalInventoryService.delete('s-rice')).rejects.toThrow(SharedBinderReadOnlyError);
        expect(local.queue).toEqual([]);
        expect(local.table('inventory_items').get('s-rice')).toMatchObject({ quantity: 2, item_name: 'Rice' });
    });

    it("refuses every delete of a skipper's row and queues nothing (A5)", async () => {
        share({ stores: access(true), equipment: true, maintenance: true, documents: true });

        await expect(LocalInventoryService.delete('s-rice')).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalEquipmentService.delete('s-engine')).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalDocumentService.delete('s-rego')).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalMaintenanceService.deleteTask('s-oil')).rejects.toThrow(SharedBinderReadOnlyError);
        expect(local.queue).toEqual([]);
        expect(local.table('maintenance_tasks').has('s-oil')).toBe(true);
    });

    it("Pause and Log Service on a skipper's task queue an UPDATE and a history row stamped with the skipper (A5)", async () => {
        share({ maintenance: true });

        await LocalMaintenanceService.deactivateTask('s-oil');
        expect(local.queue.at(-1)).toMatchObject({ table: 'maintenance_tasks', type: 'UPDATE', id: 's-oil' });

        await LocalMaintenanceService.logService('s-oil', null, 'Done', null);
        const history = local.queue.find((entry) => entry.table === 'maintenance_history');
        expect(history).toMatchObject({ type: 'INSERT', payload: { user_id: 'skipper-1', task_id: 's-oil' } });
        expect(local.queue.at(-1)).toMatchObject({ table: 'maintenance_tasks', type: 'UPDATE', id: 's-oil' });
        expect(LocalMaintenanceService.getHistory('s-oil')).toHaveLength(1);
    });

    it('never seeds default tasks into a shared R&M, nor before the server confirmed once (A12)', async () => {
        share({ maintenance: true });
        await expect(LocalMaintenanceService.seedDefaults()).resolves.toBe(0);

        localStorage.clear();
        reloadSharedBindersFromStorage();
        await expect(LocalMaintenanceService.seedDefaults()).resolves.toBe(0);
        expect(local.queue).toEqual([]);

        confirmNoShares();
        local.table('maintenance_tasks').clear();
        const seeded = await LocalMaintenanceService.seedDefaults();
        expect(seeded).toBeGreaterThan(20);
        expect(new Set(local.queue.map((entry) => entry.payload.user_id))).toEqual(new Set(['crew-1']));
    });

    it("offline with the cached share, adds still queue under the skipper's id (A14)", async () => {
        share({ stores: access(true) });
        // No refresh happens offline; only the cached snapshot is read.
        reloadSharedBindersFromStorage();
        const item = await LocalInventoryService.create(stores('ignored', '') as never);
        expect(local.queue.at(-1)).toMatchObject({ id: item.id, type: 'INSERT', payload: { user_id: 'skipper-1' } });
    });

    it("dedup never touches the skipper's rows (A16)", async () => {
        share({ stores: access(true) });
        local.table('inventory_items').set('s-rice-2', stores('s-rice-2', 'skipper-1') as never);
        local.table('inventory_items').set('c-rice-2', stores('c-rice-2', 'crew-1') as never);

        const merged = await LocalInventoryService.deduplicateByName();

        expect(merged).toBe(1);
        expect(local.table('inventory_items').has('s-rice')).toBe(true);
        expect(local.table('inventory_items').has('s-rice-2')).toBe(true);
        expect(local.queue.every((entry) => String(entry.id).startsWith('c-'))).toBe(true);
    });

    it('with no memberships, lists, creates, deletes and seeding behave as today (A10)', async () => {
        confirmNoShares();
        local.table('maintenance_tasks').clear();

        expect(LocalInventoryService.getAll().map((row) => row.id)).toEqual(['c-rice']);
        const item = await LocalInventoryService.create(stores('ignored', '') as never);
        expect(item.user_id).toBe('crew-1');
        await LocalInventoryService.delete('c-rice');
        expect(local.queue.at(-1)).toMatchObject({ type: 'DELETE', id: 'c-rice' });
        expect(await LocalMaintenanceService.seedDefaults()).toBeGreaterThan(20);
    });
});
