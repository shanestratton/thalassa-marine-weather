/**
 * LocalEquipmentService — Offline-first CRUD for Equipment Register.
 *
 * All reads/writes go to local database (vessel_equipment_register.json).
 * Mutations are queued for background sync to Supabase.
 */
import { getById, query, insertLocal, updateLocal, deleteLocal, generateUUID } from './LocalDatabase';
import { assertBinderDeletable, assertBinderWritable, binderInsertOwner, binderRowFilter } from './sharedBinders';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';
import type { EquipmentItem, EquipmentCategory } from '../../types';

const TABLE = 'equipment_register';
// The skipper's register while the sailor is crew on a boat that shares
// Equipment, otherwise the sailor's own (sharedBinders.ts).
const REGISTER = 'equipment' as const;

export class LocalEquipmentService {
    // ── READ ──

    /** Get all equipment items */
    static getAll(): EquipmentItem[] {
        return query<EquipmentItem>(TABLE, binderRowFilter(REGISTER));
    }

    /** Get by category */
    static getByCategory(category: EquipmentCategory): EquipmentItem[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<EquipmentItem>(TABLE, (item) => inBinder(item) && item.category === category);
    }

    /** Search equipment by name, make, model, or serial number */
    static search(q: string): EquipmentItem[] {
        const lower = q.toLowerCase().trim();
        if (!lower) return LocalEquipmentService.getAll();
        const inBinder = binderRowFilter(REGISTER);
        return query<EquipmentItem>(
            TABLE,
            (item) =>
                inBinder(item) &&
                (item.equipment_name.toLowerCase().includes(lower) ||
                    item.make.toLowerCase().includes(lower) ||
                    item.model.toLowerCase().includes(lower) ||
                    item.serial_number.toLowerCase().includes(lower)),
        );
    }

    // ── WRITE ──

    /** Create a new equipment item */
    static async create(
        item: Omit<EquipmentItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<EquipmentItem> {
        const owner = binderInsertOwner(REGISTER);
        const now = new Date().toISOString();
        const record: EquipmentItem = {
            ...item,
            id: generateUUID(),
            user_id: owner,
            created_at: now,
            updated_at: now,
        };
        const inserted = await insertLocal<EquipmentItem>(TABLE, record);
        dispatchDataChange(DATA_EVENTS.EQUIPMENT);
        return inserted;
    }

    /** Update an equipment item */
    static async update(id: string, updates: Partial<EquipmentItem>): Promise<EquipmentItem | null> {
        assertBinderWritable(REGISTER, getById<EquipmentItem>(TABLE, id));
        const updated = await updateLocal<EquipmentItem>(TABLE, id, updates);
        dispatchDataChange(DATA_EVENTS.EQUIPMENT);
        return updated;
    }

    /** Delete an equipment item */
    static async delete(id: string): Promise<void> {
        assertBinderDeletable(REGISTER, getById<EquipmentItem>(TABLE, id));
        await deleteLocal(TABLE, id);
        dispatchDataChange(DATA_EVENTS.EQUIPMENT);
    }
}
