/**
 * LocalDocumentService — Offline-first CRUD for Ship's Documents vault.
 *
 * All reads/writes go to local database (vessel_ship_documents.json).
 * Mutations are queued for background sync to Supabase.
 */
import { getAll, query, insertLocal, updateLocal, deleteLocal, generateUUID } from './LocalDatabase';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';
import type { ShipDocument, DocumentCategory } from '../../types';

const TABLE = 'ship_documents';

export class LocalDocumentService {
    // ── READ ──

    static getAll(): ShipDocument[] {
        return getAll<ShipDocument>(TABLE);
    }

    static getByCategory(category: DocumentCategory): ShipDocument[] {
        return query<ShipDocument>(TABLE, (item) => item.category === category);
    }

    static search(q: string): ShipDocument[] {
        const lower = q.toLowerCase().trim();
        if (!lower) return LocalDocumentService.getAll();
        return query<ShipDocument>(
            TABLE,
            (item) => item.document_name.toLowerCase().includes(lower) || item.category.toLowerCase().includes(lower),
        );
    }

    // ── WRITE ──

    static async create(
        item: Omit<ShipDocument, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<ShipDocument> {
        const now = new Date().toISOString();
        const record: ShipDocument = {
            ...item,
            id: generateUUID(),
            user_id: '',
            created_at: now,
            updated_at: now,
        };
        const inserted = await insertLocal<ShipDocument>(TABLE, record);
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
        return inserted;
    }

    static async update(id: string, updates: Partial<ShipDocument>): Promise<ShipDocument | null> {
        const updated = await updateLocal<ShipDocument>(TABLE, id, updates);
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
        return updated;
    }

    static async delete(id: string): Promise<void> {
        await deleteLocal(TABLE, id);
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
    }
}
