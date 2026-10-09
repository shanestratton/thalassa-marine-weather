/**
 * LocalDocumentService — Offline-first CRUD for Ship's Documents vault.
 *
 * All reads/writes go to local database (vessel_ship_documents.json).
 * Mutations are queued for background sync to Supabase.
 */
import { getById, query, insertLocal, updateLocal, deleteLocal, generateUUID } from './LocalDatabase';
import { assertBinderDeletable, assertBinderWritable, binderInsertOwner, binderRowFilter } from './sharedBinders';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';
import type { ShipDocument, DocumentCategory } from '../../types';

const TABLE = 'ship_documents';
// The skipper's documents while the sailor is crew on a boat that shares
// Documents, otherwise the sailor's own (sharedBinders.ts).
const REGISTER = 'documents' as const;

/**
 * Drops client-only fields (_offline, _pendingFile) so they never reach the
 * outbox: ship_documents has no such columns, and PostgREST refuses a payload
 * naming one (PGRST204), fencing the record on this phone.
 */
function withoutClientFields<T extends object>(fields: T): T {
    return Object.fromEntries(Object.entries(fields).filter(([key]) => !key.startsWith('_'))) as T;
}

export class LocalDocumentService {
    // ── READ ──

    static getAll(): ShipDocument[] {
        return query<ShipDocument>(TABLE, binderRowFilter(REGISTER));
    }

    static getByCategory(category: DocumentCategory): ShipDocument[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<ShipDocument>(TABLE, (item) => inBinder(item) && item.category === category);
    }

    static search(q: string): ShipDocument[] {
        const lower = q.toLowerCase().trim();
        if (!lower) return LocalDocumentService.getAll();
        const inBinder = binderRowFilter(REGISTER);
        return query<ShipDocument>(
            TABLE,
            (item) =>
                inBinder(item) &&
                (item.document_name.toLowerCase().includes(lower) || item.category.toLowerCase().includes(lower)),
        );
    }

    // ── WRITE ──

    static async create(
        item: Omit<ShipDocument, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<ShipDocument> {
        const owner = binderInsertOwner(REGISTER);
        const now = new Date().toISOString();
        const record: ShipDocument = {
            ...withoutClientFields(item),
            id: generateUUID(),
            user_id: owner,
            created_at: now,
            updated_at: now,
        };
        const inserted = await insertLocal<ShipDocument>(TABLE, record);
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
        return inserted;
    }

    static async update(id: string, updates: Partial<ShipDocument>): Promise<ShipDocument | null> {
        assertBinderWritable(REGISTER, getById<ShipDocument>(TABLE, id));
        const updated = await updateLocal<ShipDocument>(TABLE, id, withoutClientFields(updates));
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
        return updated;
    }

    static async delete(id: string): Promise<void> {
        assertBinderDeletable(REGISTER, getById<ShipDocument>(TABLE, id));
        await deleteLocal(TABLE, id);
        dispatchDataChange(DATA_EVENTS.DOCUMENTS);
    }
}
