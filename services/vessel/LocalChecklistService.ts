/**
 * LocalChecklistService — Offline-first CRUD for vessel checklists.
 *
 * Data model: flat list of entries, each either a 'heading' (section)
 * or 'detail' (item to check). Details belong to a heading via heading_id.
 */
import {
    getAll,
    insertLocal,
    updateLocal,
    deleteLocal,
    generateUUID,
} from './LocalDatabase';

const TABLE = 'checklists';
const RUNS_TABLE = 'checklist_runs';

// ── Types ──────────────────────────────────────────────────────

export interface ChecklistEntry {
    id: string;
    type: 'heading' | 'detail';
    text: string;
    heading_id: string | null; // null for headings, parent heading id for details
    order: number;
    created_at: string;
    updated_at: string;
}

export type RunItemStatus = 'unchecked' | 'pass' | 'fail';

export interface ChecklistRunItem {
    entry_id: string;
    heading: string;
    text: string;
    status: RunItemStatus;
    flagged_rm: boolean;
    notes: string;
}

export interface ChecklistRun {
    id: string;
    started_at: string;
    completed_at: string | null;
    items: ChecklistRunItem[];
}

// ── Service ────────────────────────────────────────────────────

export class LocalChecklistService {

    // ── READ ──

    static getAll(): ChecklistEntry[] {
        return getAll<ChecklistEntry>(TABLE).sort((a, b) => a.order - b.order);
    }

    static getHeadings(): ChecklistEntry[] {
        return LocalChecklistService.getAll().filter(e => e.type === 'heading');
    }

    static getDetailsByHeading(headingId: string): ChecklistEntry[] {
        return LocalChecklistService.getAll().filter(
            e => e.type === 'detail' && e.heading_id === headingId
        );
    }

    /** Get entries grouped by heading for display. */
    static getGrouped(): { heading: ChecklistEntry; items: ChecklistEntry[] }[] {
        const all = LocalChecklistService.getAll();
        const headings = all.filter(e => e.type === 'heading');
        return headings.map(h => ({
            heading: h,
            items: all.filter(e => e.type === 'detail' && e.heading_id === h.id)
                .sort((a, b) => a.order - b.order),
        }));
    }

    /** Total detail items count. */
    static detailCount(): number {
        return getAll<ChecklistEntry>(TABLE).filter(e => e.type === 'detail').length;
    }

    // ── WRITE ──

    static async create(
        entry: Pick<ChecklistEntry, 'type' | 'text' | 'heading_id'>
    ): Promise<ChecklistEntry> {
        const all = LocalChecklistService.getAll();
        const maxOrder = all.length > 0 ? Math.max(...all.map(e => e.order)) : 0;
        const now = new Date().toISOString();
        const record: ChecklistEntry = {
            id: generateUUID(),
            type: entry.type,
            text: entry.text,
            heading_id: entry.heading_id,
            order: maxOrder + 1,
            created_at: now,
            updated_at: now,
        };
        return await insertLocal<ChecklistEntry>(TABLE, record);
    }

    static async update(
        id: string,
        updates: Partial<ChecklistEntry>
    ): Promise<ChecklistEntry | null> {
        return await updateLocal<ChecklistEntry>(TABLE, id, {
            ...updates,
            updated_at: new Date().toISOString(),
        });
    }

    static async delete(id: string): Promise<void> {
        // If deleting a heading, also delete its child details
        const entry = getAll<ChecklistEntry>(TABLE).find(e => e.id === id);
        if (entry?.type === 'heading') {
            const children = getAll<ChecklistEntry>(TABLE).filter(
                e => e.type === 'detail' && e.heading_id === id
            );
            for (const child of children) {
                await deleteLocal(TABLE, child.id);
            }
        }
        await deleteLocal(TABLE, id);
    }

    // ── RUNS ──

    static getRuns(): ChecklistRun[] {
        return getAll<ChecklistRun>(RUNS_TABLE).sort(
            (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
    }

    static async saveRun(run: ChecklistRun): Promise<ChecklistRun> {
        // Upsert — if run exists, update; otherwise insert
        const existing = getAll<ChecklistRun>(RUNS_TABLE).find(r => r.id === run.id);
        if (existing) {
            return (await updateLocal<ChecklistRun>(RUNS_TABLE, run.id, run)) || run;
        }
        return await insertLocal<ChecklistRun>(RUNS_TABLE, run);
    }

    static async deleteRun(id: string): Promise<void> {
        await deleteLocal(RUNS_TABLE, id);
    }
}
