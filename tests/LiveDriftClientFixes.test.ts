/**
 * Client halves of the live drift repairs (build 126, package 126-19).
 *
 * 1. Two merge upserts land in tables with an INSERT policy and no UPDATE
 *    policy (voyage_log_hidden_voyages, dm_blocks). A merge upsert is
 *    INSERT ... ON CONFLICT DO UPDATE, so repeating the action (hiding a
 *    voyage again from a second device, blocking someone twice) is refused by
 *    row-level security with 42501. ignoreDuplicates makes it ON CONFLICT DO
 *    NOTHING: the row is already there, which is what the sailor asked for.
 *    The third (ChatService approveJoinRequest into channel_members) waits for
 *    Codex's ChatService rewrite to merge.
 * 2. ship_logs has never had a leg_number column, so a legNumber on an entry
 *    would make PostgREST refuse the whole upsert batch (PGRST204).
 * 3. ShipDocument's client-only fields (_offline, _pendingFile) must never
 *    reach the outbox, for the same reason.
 *
 * The PostgREST below is a fake with the server's rules; every id is fictional.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const server = vi.hoisted(() => {
    const tables = new Map<string, Set<string>>();
    const calls: Array<{ table: string; payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
    return {
        tables,
        calls,
        userId: 'sailor-a',
        reset() {
            tables.clear();
            calls.length = 0;
        },
        /**
         * An upsert against a table whose policies allow INSERT and SELECT of
         * your own rows, but no UPDATE: a conflict under merge mode is the
         * DO UPDATE arm, which RLS refuses.
         */
        upsert(table: string, payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
            calls.push({ table, payload: { ...payload }, options: { ...options } });
            const columns = String(options.onConflict ?? 'id').split(',');
            const key = columns.map((column) => String(payload[column])).join('|');
            const rows = tables.get(table) ?? new Set<string>();
            tables.set(table, rows);
            if (rows.has(key)) {
                if (options.ignoreDuplicates === true) return { data: null, error: null };
                return {
                    data: null,
                    error: {
                        code: '42501',
                        message: `new row violates row-level security policy (USING expression) for table "${table}"`,
                    },
                };
            }
            rows.add(key);
            return { data: null, error: null };
        },
    };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: vi.fn(async () => ({
                data: { user: { id: server.userId, user_metadata: {} } },
                error: null,
            })),
        },
        from: vi.fn((table: string) => ({
            upsert: (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
                const result = server.upsert(table, payload, options);
                return Promise.resolve(result);
            },
        })),
    },
    supabaseUrl: 'https://example.supabase.co',
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const local = vi.hoisted(() => ({
    rows: new Map<string, Record<string, unknown>>(),
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/vessel/LocalDatabase', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/vessel/LocalDatabase')>()),
    getById: vi.fn((_table: string, id: string) => local.rows.get(id) ?? null),
    insertLocal: vi.fn(async (_table: string, record: Record<string, unknown>) => {
        local.inserted.push({ ...record });
        local.rows.set(String(record.id), record);
        return record;
    }),
    updateLocal: vi.fn(async (_table: string, id: string, updates: Record<string, unknown>) => {
        local.updated.push({ ...updates });
        const updated = { ...(local.rows.get(id) ?? {}), ...updates };
        local.rows.set(id, updated);
        return updated;
    }),
}));

vi.mock('../services/vessel/sharedBinders', () => ({
    assertBinderDeletable: vi.fn(),
    assertBinderWritable: vi.fn(),
    binderInsertOwner: vi.fn(() => 'sailor-a'),
    binderRowFilter: vi.fn(() => () => true),
}));

vi.mock('../utils/dataChangeEvents', () => ({
    DATA_EVENTS: { DOCUMENTS: 'documents' },
    dispatchDataChange: vi.fn(),
}));

import { VoyageLogService } from '../services/VoyageLogService';
import { LonelyHeartsService } from '../services/LonelyHeartsService';
import { fromDbFormat, toDbFormat } from '../services/shiplog/helpers';
import { LocalDocumentService } from '../services/vessel/LocalDocumentService';

beforeEach(() => {
    server.reset();
    local.rows.clear();
    local.inserted.length = 0;
    local.updated.length = 0;
    setAuthIdentityScope(null);
    setAuthIdentityScope('sailor-a');
});

describe('repeat actions on insert-only tables no longer fail (A9)', () => {
    it('hiding a voyage that is already hidden (say, from a second device) succeeds', async () => {
        await expect(VoyageLogService.setVoyageHidden('voyage-falmouth-1', true)).resolves.toBe(true);
        await expect(VoyageLogService.setVoyageHidden('voyage-falmouth-1', true)).resolves.toBe(true);
        expect(VoyageLogService.lastError).toBeNull();

        const upserts = server.calls.filter((call) => call.table === 'voyage_log_hidden_voyages');
        expect(upserts).toHaveLength(2);
        for (const call of upserts) {
            expect(call.payload).toEqual({ user_id: 'sailor-a', voyage_id: 'voyage-falmouth-1' });
            expect(call.options).toEqual({ onConflict: 'user_id,voyage_id', ignoreDuplicates: true });
        }
    });

    it('blocking a sailor who is already blocked succeeds', async () => {
        await expect(LonelyHeartsService.blockCrewListUser('sailor-b')).resolves.toBe(true);
        await expect(LonelyHeartsService.blockCrewListUser('sailor-b')).resolves.toBe(true);

        const upserts = server.calls.filter((call) => call.table === 'dm_blocks');
        expect(upserts).toHaveLength(2);
        for (const call of upserts) {
            expect(call.payload).toEqual({ blocker_id: 'sailor-a', blocked_id: 'sailor-b' });
            expect(call.options).toEqual({ onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true });
        }
    });

    it('the fake server refuses a merge upsert on a conflict, as live does', () => {
        server.upsert('dm_blocks', { blocker_id: 'x', blocked_id: 'y' }, { onConflict: 'blocker_id,blocked_id' });
        const again = server.upsert(
            'dm_blocks',
            { blocker_id: 'x', blocked_id: 'y' },
            { onConflict: 'blocker_id,blocked_id' },
        );
        expect(again.error?.code).toBe('42501');
    });
});

describe('a ship log entry never names a column ship_logs lacks (A8)', () => {
    it('drops legNumber from the row it writes', () => {
        const row = toDbFormat({
            id: 'entry-1',
            voyageId: 'voyage-falmouth-1',
            notes: 'Cleared the breakwater at Horta',
            legNumber: 2,
        });
        expect(row).not.toHaveProperty('leg_number');
        expect(row).toMatchObject({
            id: 'entry-1',
            voyage_id: 'voyage-falmouth-1',
            notes: 'Cleared the breakwater at Horta',
        });
    });

    it('still reads a leg number if a row ever carries one', () => {
        expect(fromDbFormat({ id: 'entry-1', leg_number: 3 }).legNumber).toBe(3);
        expect(fromDbFormat({ id: 'entry-1' }).legNumber).toBeUndefined();
    });
});

describe("a document's client-only fields never reach the outbox (A8)", () => {
    it('create queues no underscore-prefixed field', async () => {
        const created = await LocalDocumentService.create({
            document_name: 'Watermaker manual',
            category: 'User Manuals',
            issue_date: null,
            expiry_date: null,
            file_uri: null,
            notes: null,
            _offline: true,
            _pendingFile: 'file:///fictional/watermaker.pdf',
        });

        expect(local.inserted).toHaveLength(1);
        const queued = local.inserted[0];
        expect(Object.keys(queued).filter((key) => key.startsWith('_'))).toEqual([]);
        expect(queued).toMatchObject({
            document_name: 'Watermaker manual',
            category: 'User Manuals',
            user_id: 'sailor-a',
        });
        expect(created).not.toHaveProperty('_offline');
        expect(created).not.toHaveProperty('_pendingFile');
    });

    it('update queues no underscore-prefixed field either', async () => {
        local.rows.set('doc-1', { id: 'doc-1', user_id: 'sailor-a', document_name: 'Radio licence' });
        await LocalDocumentService.update('doc-1', {
            notes: 'Renew before the Atlantic crossing',
            _offline: true,
            _pendingFile: 'file:///fictional/licence.pdf',
        });
        expect(local.updated).toEqual([{ notes: 'Renew before the Atlantic crossing' }]);
    });
});
