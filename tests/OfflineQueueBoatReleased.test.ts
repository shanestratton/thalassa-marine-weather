/**
 * OfflineQueue — the one retry for a released/archived boat (2026-09-08).
 *
 * Shane's decision: letting go of a hull is Release, and it must never stall
 * the OTHER device that is still recording under that boat. The ownership
 * trigger `assign_and_validate_operational_boat_id` (20260727120000) refuses
 * such rows with Postgres 42501 "Operational boat does not belong to this row
 * owner or is unavailable". These tests pin the queue's answer to that:
 *
 *   - the refused chunk is re-sent exactly once with every row's boat_id
 *     cleared, so the server attributes the points to the writer's active
 *     owned vessel (or leaves NULL) and the queue drains as normal;
 *   - a second 42501 on the cleared retry keeps the chunk like any transient
 *     failure — live track points are NEVER dead-lettered for this;
 *   - any other 42501 (an RLS refusal, say) is not retried at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- In-memory Preferences ----
const store: Record<string, string> = {};
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: store[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete store[key];
        }),
    },
}));

// ---- Supabase mock: scripted upsert outcomes, every call recorded ----
interface MockUploadError {
    message: string;
    code?: string;
}
interface MockUpsertResult {
    error: MockUploadError | null;
    status?: number;
}
interface RecordedUpsert {
    rows: Record<string, unknown>[];
    options: Record<string, unknown>;
}

const upsertCalls: RecordedUpsert[] = [];
/** Consumed in order; once exhausted every upsert succeeds. `null` = success. */
let scriptedResults: Array<MockUploadError | null> = [];
/** Runs once, right after an upsert is recorded — flips identity mid-sync. */
let afterUpsert: (() => void) | null = null;

const RELEASED_BOAT_REFUSAL: MockUploadError = {
    code: '42501',
    message: 'Operational boat does not belong to this row owner or is unavailable',
};
const RLS_REFUSAL: MockUploadError = {
    code: '42501',
    message: 'new row violates row-level security policy for table "ship_logs"',
};

const mockUpsert = vi.fn(
    async (rows: Record<string, unknown>[], options?: Record<string, unknown>): Promise<MockUpsertResult> => {
        upsertCalls.push({ rows: rows.map((row) => ({ ...row })), options: options ?? {} });
        if (afterUpsert) {
            const hook = afterUpsert;
            afterUpsert = null;
            hook();
        }
        const next = scriptedResults.length > 0 ? scriptedResults.shift() : null;
        // PostgREST surfaces a raised 42501 as HTTP 403 with the trigger text.
        return next ? { error: next, status: 403 } : { error: null, status: 201 };
    },
);

let mockUser: { id: string } | null = { id: 'user-1' };

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => {
            if (table !== 'ship_logs') {
                throw new Error(`unexpected table in boat-release sync test: ${table}`);
            }
            return {
                upsert: (rows: Record<string, unknown>[], options?: Record<string, unknown>) => {
                    const result = mockUpsert(rows, options);
                    const query = {
                        abortSignal: vi.fn(() => query),
                        then: (
                            onFulfilled: (value: MockUpsertResult) => unknown,
                            onRejected?: (reason: unknown) => unknown,
                        ) => result.then(onFulfilled, onRejected),
                    };
                    return query;
                },
            };
        },
    },
    getCurrentUser: vi.fn(async () => mockUser),
    getCurrentUserId: vi.fn(async () => mockUser?.id ?? null),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    queueOfflineEntry,
    syncOfflineQueue,
    getOfflineQueueCount,
    getOfflineQueueDeadLetters,
    __resetOfflineQueueForTests,
} from '../services/shiplog/OfflineQueue';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { ShipLogEntry } from '../types';

const SERENE_SUMMER = 'boat-serene-summer';

const entry = (o: Partial<ShipLogEntry> = {}): Partial<ShipLogEntry> => ({
    userId: 'user-1',
    voyageId: 'v1',
    timestamp: '2026-09-08T00:00:00.000Z',
    latitude: -27.2,
    longitude: 153.1,
    entryType: 'auto',
    ...o,
});

/** Three points from one voyage: two stamped with the boat, one legacy point without. */
async function queueThreePoints(): Promise<void> {
    await queueOfflineEntry(entry({ boatId: SERENE_SUMMER, notes: 'first' }), { operationId: 'op-first' });
    await queueOfflineEntry(entry({ boatId: SERENE_SUMMER, notes: 'second' }), { operationId: 'op-second' });
    await queueOfflineEntry(entry({ notes: 'no boat' }), { operationId: 'op-no-boat' });
}

beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    __resetOfflineQueueForTests();
    upsertCalls.length = 0;
    scriptedResults = [];
    afterUpsert = null;
    mockUser = { id: 'user-1' };
    setAuthIdentityScope(null);
    setAuthIdentityScope('user-1');
});

describe('syncOfflineQueue — released/archived boat (42501) retry', () => {
    it('re-sends the refused chunk once with every boat_id cleared and drains the queue', async () => {
        await queueThreePoints();
        scriptedResults = [RELEASED_BOAT_REFUSAL];

        await expect(syncOfflineQueue()).resolves.toBe(3);

        expect(upsertCalls).toHaveLength(2);
        // First attempt shipped the boat the device was tracking under.
        expect(upsertCalls[0].rows.map((row) => row.boat_id)).toEqual([SERENE_SUMMER, SERENE_SUMMER, undefined]);
        // The retry clears boat_id on EVERY row (the server resolves the
        // writer's active owned vessel or leaves NULL) and is otherwise the
        // same idempotent upsert — same operations, same order, same owner.
        const retry = upsertCalls[1];
        expect(retry.rows.map((row) => row.boat_id)).toEqual([null, null, null]);
        expect(retry.rows.map((row) => row.client_operation_id)).toEqual(
            upsertCalls[0].rows.map((row) => row.client_operation_id),
        );
        expect(retry.rows.map((row) => row.client_operation_id)).toEqual(['op-first', 'op-second', 'op-no-boat']);
        expect(retry.rows.every((row) => row.user_id === 'user-1')).toBe(true);
        expect(retry.options).toMatchObject({ onConflict: 'user_id,client_operation_id', ignoreDuplicates: true });

        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    it('keeps the chunk — never dead-letters it — when the cleared retry is refused again', async () => {
        await queueThreePoints();
        scriptedResults = [RELEASED_BOAT_REFUSAL, RELEASED_BOAT_REFUSAL];

        await expect(syncOfflineQueue()).resolves.toBe(0);

        // Exactly one retry, then treated as a transient failure.
        expect(upsertCalls).toHaveLength(2);
        expect(upsertCalls[1].rows.every((row) => row.boat_id === null)).toBe(true);
        expect(await getOfflineQueueCount()).toBe(3);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);

        // The points survive intact for the next sync, boat and all.
        upsertCalls.length = 0;
        await expect(syncOfflineQueue()).resolves.toBe(3);
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0].rows.map((row) => row.boat_id)).toEqual([SERENE_SUMMER, SERENE_SUMMER, undefined]);
        expect(await getOfflineQueueCount()).toBe(0);
    });

    it("does not retry an unrelated 42501 (RLS refusal) — today's transient path is untouched", async () => {
        await queueThreePoints();
        scriptedResults = [RLS_REFUSAL];

        await expect(syncOfflineQueue()).resolves.toBe(0);

        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0].rows.some((row) => row.boat_id === null)).toBe(false);
        expect(await getOfflineQueueCount()).toBe(3);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    it('matches the trigger wording tolerantly but never a non-42501 code', async () => {
        await queueThreePoints();
        // A reworded/re-cased trigger message still routes to the one retry…
        scriptedResults = [{ code: '42501', message: 'OPERATIONAL  BOAT is unavailable' }];
        await expect(syncOfflineQueue()).resolves.toBe(3);
        expect(upsertCalls).toHaveLength(2);
        expect(upsertCalls[1].rows.every((row) => row.boat_id === null)).toBe(true);

        // …while the same words under a different SQLSTATE do not.
        upsertCalls.length = 0;
        await queueOfflineEntry(entry({ boatId: SERENE_SUMMER, notes: 'later' }), { operationId: 'op-later' });
        scriptedResults = [{ code: '23503', message: 'Operational boat does not belong to this row owner' }];
        await expect(syncOfflineQueue()).resolves.toBe(0);
        expect(upsertCalls).toHaveLength(1);
        expect(await getOfflineQueueCount()).toBe(1);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    it('never fires the cleared retry once the identity scope has moved on', async () => {
        await queueThreePoints();
        scriptedResults = [RELEASED_BOAT_REFUSAL];
        // Another account signs in on this handset while the refused upsert is
        // in flight. The retry is a second await, so it must re-check the fence
        // before it sends anything under the first skipper's rows.
        afterUpsert = () => {
            setAuthIdentityScope('user-2');
        };

        await expect(syncOfflineQueue()).resolves.toBe(0);

        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0].rows.some((row) => row.boat_id === null)).toBe(false);

        // The first skipper's points are untouched and drain when they are back.
        setAuthIdentityScope('user-1');
        expect(await getOfflineQueueCount()).toBe(3);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
        upsertCalls.length = 0;
        await expect(syncOfflineQueue()).resolves.toBe(3);
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0].rows.map((row) => row.boat_id)).toEqual([SERENE_SUMMER, SERENE_SUMMER, undefined]);
        expect(await getOfflineQueueCount()).toBe(0);
    });

    it('retries only the refused chunk of a multi-chunk backlog and reports the honest synced count', async () => {
        for (let i = 0; i < 501; i++) {
            await queueOfflineEntry(
                entry({
                    boatId: SERENE_SUMMER,
                    timestamp: `2026-09-08T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(
                        2,
                        '0',
                    )}.000Z`,
                }),
                { operationId: `op-${i}` },
            );
        }
        // First 500-row chunk lands; the 1-row tail is refused once.
        scriptedResults = [null, RELEASED_BOAT_REFUSAL];

        await expect(syncOfflineQueue()).resolves.toBe(501);

        expect(upsertCalls).toHaveLength(3);
        expect(upsertCalls[0].rows).toHaveLength(500);
        expect(upsertCalls[0].rows.every((row) => row.boat_id === SERENE_SUMMER)).toBe(true);
        expect(upsertCalls[1].rows).toHaveLength(1);
        expect(upsertCalls[1].rows[0].boat_id).toBe(SERENE_SUMMER);
        expect(upsertCalls[2].rows).toHaveLength(1);
        expect(upsertCalls[2].rows[0]).toMatchObject({ boat_id: null, client_operation_id: 'op-500' });
        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    // The ownership trigger is BEFORE INSERT (20260727120000), so it fires
    // ahead of every CHECK/NOT NULL constraint: a chunk holding both a released
    // boat and a genuinely poisoned row fails 42501 first and only shows the
    // poison once the boat is cleared. The bisection that follows must keep
    // the cleared flag or the poison hunt would re-trigger the one retry at
    // every level and could dead-letter healthy points still stamped with the
    // released boat.
    const POISON_ROW: MockUploadError = {
        code: '23514',
        message: 'new row for relation "ship_logs" violates check constraint "ship_logs_latitude_check"',
    };

    it('bisects a poison row hiding behind the released-boat refusal with the boat still cleared', async () => {
        await queueThreePoints();
        // 3 rows refused for the boat -> cleared retry exposes the poison ->
        // bisect [first, second] (lands) / [no boat] (poison, dead-lettered).
        scriptedResults = [RELEASED_BOAT_REFUSAL, POISON_ROW, null, POISON_ROW];

        await expect(syncOfflineQueue()).resolves.toBe(2);

        expect(upsertCalls).toHaveLength(4);
        expect(upsertCalls[0].rows.map((row) => row.boat_id)).toEqual([SERENE_SUMMER, SERENE_SUMMER, undefined]);
        // Every send after the refusal carries the cleared boat — the halves included.
        for (const call of upsertCalls.slice(1)) {
            expect(call.rows.every((row) => row.boat_id === null)).toBe(true);
        }
        expect(upsertCalls[2].rows.map((row) => row.client_operation_id)).toEqual(['op-first', 'op-second']);
        expect(upsertCalls[3].rows.map((row) => row.client_operation_id)).toEqual(['op-no-boat']);

        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([
            expect.objectContaining({ queueId: 'op-no-boat', errorCode: '23514' }),
        ]);
    });

    it('never clears the boat a second time when a cleared half is refused again', async () => {
        await queueThreePoints();
        // Cleared retry exposes a poison; the [no boat] half then comes back
        // 42501 even though it was already sent cleared. Without the threaded
        // flag this would fire a fifth, pointless cleared send.
        scriptedResults = [RELEASED_BOAT_REFUSAL, POISON_ROW, null, RELEASED_BOAT_REFUSAL];

        await expect(syncOfflineQueue()).resolves.toBe(2);

        expect(upsertCalls).toHaveLength(4);
        // The landed half is committed; the refused half is kept, not dead-lettered.
        expect(await getOfflineQueueCount()).toBe(1);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
        upsertCalls.length = 0;
        await expect(syncOfflineQueue()).resolves.toBe(1);
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0].rows.map((row) => row.client_operation_id)).toEqual(['op-no-boat']);
    });

    it('gives a half refused during an ordinary poison hunt its own single cleared retry', async () => {
        await queueThreePoints();
        // Poison surfaces first (row order decides which check fails first);
        // the [first, second] half is then refused for the boat and gets one
        // cleared send of its own before the [no boat] poison is isolated.
        scriptedResults = [POISON_ROW, RELEASED_BOAT_REFUSAL, null, POISON_ROW];

        await expect(syncOfflineQueue()).resolves.toBe(2);

        expect(upsertCalls).toHaveLength(4);
        expect(upsertCalls[1].rows.map((row) => row.boat_id)).toEqual([SERENE_SUMMER, SERENE_SUMMER]);
        expect(upsertCalls[2].rows.map((row) => row.boat_id)).toEqual([null, null]);
        expect(upsertCalls[2].rows.map((row) => row.client_operation_id)).toEqual(['op-first', 'op-second']);
        // The untouched half keeps its original (absent) boat on the way to the dead letter.
        expect(upsertCalls[3].rows.map((row) => row.client_operation_id)).toEqual(['op-no-boat']);
        expect(upsertCalls[3].rows[0].boat_id).toBeUndefined();

        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([
            expect.objectContaining({ queueId: 'op-no-boat', errorCode: '23514' }),
        ]);
    });
});
