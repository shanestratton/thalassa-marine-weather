// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { countBlockedReplanBackends } from '../supabase/tests/replan138-race-observation.mjs';

const pids = Array.from({ length: 16 }, (_, i) => i + 100);
describe('actual PostgreSQL race observation adapter', () => {
    it.each([0, 7, 16])(
        'passes SQL text and the PID array to the explicit coordinator, preserving count %s',
        async (blocked) => {
            const client = {
                query: vi.fn(async (text: string, args?: number[][]) => {
                    expect(typeof text).toBe('string');
                    if (text.includes('pg_stat_clear_snapshot')) return { rows: [] };
                    expect(text).toContain('pg_stat_activity');
                    expect(args).toEqual([pids]);
                    return { rows: [{ blocked }] };
                }),
            };
            expect(await countBlockedReplanBackends(client, pids)).toBe(blocked);
            expect(client.query).toHaveBeenCalledTimes(2);
        },
    );
    it.each([[], pids.slice(1), [...pids.slice(1), pids[1]], [...pids.slice(1), NaN]])(
        'rejects invalid participant identities before querying',
        async (participants) => {
            const client = { query: vi.fn() };
            await expect(countBlockedReplanBackends(client, participants)).rejects.toThrow('Sixteen distinct');
            expect(client.query).not.toHaveBeenCalled();
        },
    );
    it.each([undefined, NaN, -1, 17])(
        'cannot report malformed or excessive backend counts as proof',
        async (blocked) => {
            const client = { query: vi.fn(async () => ({ rows: [{ blocked }] })) };
            await expect(countBlockedReplanBackends(client, pids)).rejects.toThrow('Invalid actual backend');
        },
    );
});
