/**
 * The phone's side of the wx → Supabase contract. What matters: the cell id
 * is stable and matches the migration's regex; the announce is change-
 * detected (a moored boat must cost ~4 writes a day, not one per fetch); and
 * a published row is preferred only while fresh — everything else falls
 * through to the live proxy silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({
    upserts: [] as unknown[],
    single: null as unknown,
    list: [] as unknown[],
}));
vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => ({
            upsert: (row: unknown) => {
                sb.upserts.push({ table, row });
                return Promise.resolve({ error: null });
            },
            select: () => ({
                eq: () => ({
                    eq: () => ({ maybeSingle: () => Promise.resolve({ data: sb.single, error: null }) }),
                    then: (fn: (r: unknown) => unknown) => Promise.resolve(fn({ data: sb.list, error: null })),
                }),
            }),
        }),
    },
}));

import { announceCell, cellIdFor, fetchPublishedForecast } from '../services/weather/wxPublished';

beforeEach(() => {
    sb.upserts.length = 0;
    sb.single = null;
    localStorage.clear();
});

describe('cell ids', () => {
    it('snaps to the 0.25° SW corner, matching the migration regex', () => {
        const re = /^-?\d{1,4}_-?\d{1,5}$/;
        for (const [lat, lon, want] of [
            [-27.21, 153.06, '-2725_15300'],
            [-27.25, 153.0, '-2725_15300'], // exactly on the corner stays in its cell
            [-27.26, 153.24, '-2750_15300'],
            [0.1, 0.1, '0_0'],
            [-0.1, -0.1, '-25_-25'],
        ] as const) {
            const id = cellIdFor(lat, lon);
            expect(id).toBe(want);
            expect(id).toMatch(re);
        }
    });
});

describe('announce is change-detected', () => {
    it('writes once per cell, again only after 6h or a cell change', () => {
        announceCell(-27.21, 153.06);
        announceCell(-27.22, 153.07); // same cell — silent
        expect(sb.upserts).toHaveLength(1);
        announceCell(-27.3, 153.07); // new cell
        expect(sb.upserts).toHaveLength(2);
    });
});

describe('published rows are preferred only while fresh', () => {
    it('returns a fresh row', async () => {
        sb.single = { payload: { hourly: {} }, run_at: new Date().toISOString() };
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).not.toBeNull();
    });
    it('rejects a stale run — the live proxy is better than day-old data', async () => {
        sb.single = { payload: {}, run_at: new Date(Date.now() - 25 * 3_600_000).toISOString() };
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).toBeNull();
    });
    it('absence is silence, not an error', async () => {
        sb.single = null;
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).toBeNull();
    });
});
