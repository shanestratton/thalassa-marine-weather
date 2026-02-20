/**
 * LocalEquipmentService — Offline-first CRUD for Equipment Register.
 *
 * All reads/writes go to local database (vessel_equipment_register.json).
 * Mutations are queued for background sync to Supabase.
 */
import {
    getAll,
    query,
    insertLocal,
    updateLocal,
    deleteLocal,
    generateUUID,
} from './LocalDatabase';
import type { EquipmentItem, EquipmentCategory } from '../../types';

const TABLE = 'equipment_register';

export class LocalEquipmentService {

    // ── READ ──

    /** Get all equipment items */
    static getAll(): EquipmentItem[] {
        return getAll<EquipmentItem>(TABLE);
    }

    /** Get by category */
    static getByCategory(category: EquipmentCategory): EquipmentItem[] {
        return query<EquipmentItem>(TABLE, item => item.category === category);
    }

    /** Search equipment by name, make, model, or serial number */
    static search(q: string): EquipmentItem[] {
        const lower = q.toLowerCase().trim();
        if (!lower) return LocalEquipmentService.getAll();
        return query<EquipmentItem>(TABLE, item =>
            item.equipment_name.toLowerCase().includes(lower) ||
            item.make.toLowerCase().includes(lower) ||
            item.model.toLowerCase().includes(lower) ||
            item.serial_number.toLowerCase().includes(lower)
        );
    }

    // ── WRITE ──

    /** Create a new equipment item */
    static async create(
        item: Omit<EquipmentItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>
    ): Promise<EquipmentItem> {
        const now = new Date().toISOString();
        const record: EquipmentItem = {
            ...item,
            id: generateUUID(),
            user_id: '',
            created_at: now,
            updated_at: now,
        };
        return await insertLocal<EquipmentItem>(TABLE, record);
    }

    /** Update an equipment item */
    static async update(
        id: string,
        updates: Partial<EquipmentItem>
    ): Promise<EquipmentItem | null> {
        return await updateLocal<EquipmentItem>(TABLE, id, updates);
    }

    /** Delete an equipment item */
    static async delete(id: string): Promise<void> {
        await deleteLocal(TABLE, id);
    }
}
