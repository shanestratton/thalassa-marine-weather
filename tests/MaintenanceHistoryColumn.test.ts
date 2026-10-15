/**
 * The column probe that says whether the server keeps a deleted task's
 * service records (131-B7). The held migration adds task_title and the SET
 * NULL key together, so seeing the column is seeing the change. Anything short
 * of seeing it ("absent", "could not ask", "not asked yet") means the records
 * go, as they did before the push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    __resetMaintenanceHistoryColumnForTests,
    maintenanceHistoryKeepsRecords,
    maintenanceHistoryKeptKnown,
} from '../services/vessel/maintenanceHistoryColumn';

type Answer = { data?: unknown; error: { code?: string; message?: string } | null };

/** A client whose probe read answers `answer`, recording what it was asked. */
function client(answer: Answer | Promise<Answer> | (() => never)) {
    const asked: { table: string; columns: string; limit: number }[] = [];
    return {
        asked,
        from: (table: string) => ({
            select: (columns: string) => ({
                limit: (limit: number) => {
                    asked.push({ table, columns, limit });
                    return typeof answer === 'function' ? answer() : Promise.resolve(answer);
                },
            }),
        }),
    };
}

const MISSING_COLUMN = { code: '42703', message: 'column maintenance_history.task_title does not exist' };

beforeEach(() => __resetMaintenanceHistoryColumnForTests());
afterEach(() => vi.useRealTimers());

describe('the task_title column probe', () => {
    it('reads the column and no rows, and remembers a present column for the session', async () => {
        const server = client({ data: [], error: null });
        expect(maintenanceHistoryKeptKnown()).toBe(false);
        await expect(maintenanceHistoryKeepsRecords(server)).resolves.toBe(true);
        expect(server.asked).toEqual([{ table: 'maintenance_history', columns: 'task_title', limit: 0 }]);
        expect(maintenanceHistoryKeptKnown()).toBe(true);

        // Asked again later: no second request.
        await expect(maintenanceHistoryKeepsRecords(server)).resolves.toBe(true);
        expect(server.asked).toHaveLength(1);
    });

    it.each([
        ['Postgres', MISSING_COLUMN],
        ['PostgREST', { code: 'PGRST204', message: "Could not find the 'task_title' column of 'maintenance_history'" }],
    ])(
        'takes %s saying the column is missing as "the records go", and asks again only after an hour',
        async (_, error) => {
            const now = Date.parse('2026-10-15T00:00:00.000Z');
            const server = client({ error });
            await expect(maintenanceHistoryKeepsRecords(server, now)).resolves.toBe(false);
            expect(maintenanceHistoryKeptKnown()).toBe(false);
            await expect(maintenanceHistoryKeepsRecords(server, now + 59 * 60_000)).resolves.toBe(false);
            expect(server.asked).toHaveLength(1);
            await expect(maintenanceHistoryKeepsRecords(server, now + 61 * 60_000)).resolves.toBe(false);
            expect(server.asked).toHaveLength(2);
        },
    );

    it('says no, and asks again next time, when it could not ask: refused, offline, no client', async () => {
        const refused = client({
            error: { code: '42501', message: 'permission denied for table maintenance_history' },
        });
        await expect(maintenanceHistoryKeepsRecords(refused)).resolves.toBe(false);
        await expect(maintenanceHistoryKeepsRecords(refused)).resolves.toBe(false);
        expect(refused.asked).toHaveLength(2);

        const offline = client(() => {
            throw new TypeError('Failed to fetch');
        });
        await expect(maintenanceHistoryKeepsRecords(offline)).resolves.toBe(false);
        await expect(maintenanceHistoryKeepsRecords(null)).resolves.toBe(false);
        await expect(maintenanceHistoryKeepsRecords({})).resolves.toBe(false);
        expect(maintenanceHistoryKeptKnown()).toBe(false);
    });

    it('gives up after five seconds without an answer, and two asks at once share one request', async () => {
        vi.useFakeTimers();
        const server = client(new Promise<Answer>(() => undefined));
        const first = maintenanceHistoryKeepsRecords(server);
        const second = maintenanceHistoryKeepsRecords(server);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
        expect(server.asked).toHaveLength(1);
        expect(maintenanceHistoryKeptKnown()).toBe(false);
    });
});
