/**
 * The offline queue writes ship_logs.position_source ONLY once it has seen the
 * column exist (build 123, package VL).
 *
 * The migration (20261007183000_ship_log_position_source.sql) is written but
 * not applied: `supabase db push` waits for Shane's per-action yes. PostgREST
 * refuses an insert that names an unknown column, and the queue treats a
 * permanent refusal by bisecting down to one row and dead-lettering it — a
 * whole voyage of track points moved aside for want of one column. So the
 * client asks first, and the answer "absent" (or "could not ask") means the
 * field is simply left off: the voyage uploads exactly as it did before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

type ProbeOutcome = 'present' | 'absent' | 'offline';
const backend = vi.hoisted(() => ({
    probe: 'absent' as ProbeOutcome,
    probes: 0,
    probedColumns: [] as string[],
    upserts: [] as Record<string, unknown>[][],
    /** A server without the column refuses any row that names it. */
    columnExists: false,
}));

vi.mock('../services/supabase', () => {
    const thenable = <T>(value: Promise<T>) => {
        const query = {
            abortSignal: () => query,
            limit: () => query,
            then: (onFulfilled: (v: T) => unknown, onRejected?: (reason: unknown) => unknown) =>
                value.then(onFulfilled, onRejected),
        };
        return query;
    };
    return {
        supabase: {
            from: (table: string) => {
                if (table !== 'ship_logs') throw new Error(`unexpected table ${table}`);
                return {
                    select: (columns: string) => {
                        backend.probes += 1;
                        backend.probedColumns.push(columns);
                        if (backend.probe === 'offline') return thenable(Promise.reject(new Error('offline')));
                        return thenable(
                            Promise.resolve(
                                backend.probe === 'present'
                                    ? { data: [], error: null, status: 200 }
                                    : {
                                          data: null,
                                          error: {
                                              code: '42703',
                                              message: 'column ship_logs.position_source does not exist',
                                          },
                                          status: 400,
                                      },
                            ),
                        );
                    },
                    upsert: (rows: Record<string, unknown>[]) => {
                        backend.upserts.push(rows.map((row) => ({ ...row })));
                        const refused = !backend.columnExists && rows.some((row) => 'position_source' in row);
                        return thenable(
                            Promise.resolve(
                                refused
                                    ? {
                                          error: {
                                              code: 'PGRST204',
                                              message:
                                                  "Could not find the 'position_source' column of 'ship_logs' in the schema cache",
                                          },
                                          status: 400,
                                      }
                                    : { error: null, status: 201 },
                            ),
                        );
                    },
                };
            },
        },
        getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
        getCurrentUserId: vi.fn(async () => 'user-1'),
    };
});

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
import { __resetPositionSourceColumnForTests } from '../services/shiplog/positionSourceColumn';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { ShipLogEntry } from '../types';

const point = (o: Partial<ShipLogEntry>): Partial<ShipLogEntry> => ({
    userId: 'user-1',
    voyageId: 'v-solent',
    timestamp: '2026-10-07T09:00:00.000Z',
    latitude: 50.7712,
    longitude: -1.3005,
    entryType: 'auto',
    ...o,
});

async function queueMixedVoyage(): Promise<void> {
    await queueOfflineEntry(point({ positionSource: 'vessel' }), { operationId: 'op-bus' });
    await queueOfflineEntry(point({ positionSource: 'phone', latitude: 50.7722 }), { operationId: 'op-phone' });
    // Captured before this build: no tag, and none invented.
    await queueOfflineEntry(point({ latitude: 50.7732 }), { operationId: 'op-legacy' });
}

beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    __resetOfflineQueueForTests();
    __resetPositionSourceColumnForTests();
    backend.probe = 'absent';
    backend.probes = 0;
    backend.probedColumns = [];
    backend.upserts = [];
    backend.columnExists = false;
    setAuthIdentityScope(null);
    setAuthIdentityScope('user-1');
});

describe('position_source behind a column-present probe', () => {
    it('column absent (the migration not yet pushed): the field is left off and the voyage uploads as before', async () => {
        await queueMixedVoyage();
        await expect(syncOfflineQueue()).resolves.toBe(3);
        expect(backend.probedColumns).toEqual(['position_source']);
        expect(backend.upserts).toHaveLength(1);
        expect(backend.upserts[0].some((row) => 'position_source' in row)).toBe(false);
        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    it('could not ask (offline probe): the field is left off, nothing wedges', async () => {
        backend.probe = 'offline';
        await queueMixedVoyage();
        await expect(syncOfflineQueue()).resolves.toBe(3);
        expect(backend.upserts[0].some((row) => 'position_source' in row)).toBe(false);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([]);
    });

    it('column present (after `supabase db push`): each tagged row carries its source; untagged rows stay null', async () => {
        backend.probe = 'present';
        backend.columnExists = true;
        await queueMixedVoyage();
        await expect(syncOfflineQueue()).resolves.toBe(3);
        const rows = backend.upserts[0];
        expect(rows.map((row) => row.client_operation_id)).toEqual(['op-bus', 'op-phone', 'op-legacy']);
        expect(rows.map((row) => row.position_source)).toEqual(['vessel', 'phone', undefined]);
        expect('position_source' in rows[2]).toBe(false);
    });

    it('asks once per session when the column is there, not before every upload', async () => {
        backend.probe = 'present';
        backend.columnExists = true;
        await queueMixedVoyage();
        await syncOfflineQueue();
        await queueOfflineEntry(point({ positionSource: 'vessel-relay' }), { operationId: 'op-relay' });
        await syncOfflineQueue();
        expect(backend.probes).toBe(1);
        expect(backend.upserts[1][0].position_source).toBe('vessel-relay');
    });

    it('never sends a value outside the vocabulary the CHECK allows', async () => {
        backend.probe = 'present';
        backend.columnExists = true;
        await queueOfflineEntry(point({ positionSource: 'nmea' as unknown as ShipLogEntry['positionSource'] }), {
            operationId: 'op-odd',
        });
        await syncOfflineQueue();
        expect('position_source' in backend.upserts[0][0]).toBe(false);
    });
});
