/**
 * The phone's side of the wx → Supabase contract. What matters: the cell id
 * is stable and matches the migration's regex; the announce is change-
 * detected (a moored boat must cost ~4 writes a day, not one per fetch); and
 * a published row is preferred only while fresh — everything else falls
 * through to the live proxy silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wxFixture } from './fixtures/wxPublishedFixture';

const sb = vi.hoisted(() => ({
    upserts: [] as unknown[],
    single: null as unknown,
    list: [] as unknown[],
    filters: [] as unknown[],
}));
vi.mock('../services/supabase', () => ({
    supabase: {
        // Since 2026-09-05 (audit item 15) announce goes through the RPC, not a
        // table upsert; the RPC validates, stamps the time and caps the table.
        rpc: (fn: string, args: unknown) => {
            sb.upserts.push({ table: fn, row: args });
            return Promise.resolve({ data: true, error: null });
        },
        from: (table: string) => ({
            upsert: (row: unknown) => {
                sb.upserts.push({ table, row });
                return Promise.resolve({ error: null });
            },
            select: () => ({
                eq: (key: string, value: string) => {
                    sb.filters.push([key, value]);
                    return {
                        eq: (secondKey: string, secondValue: string) => {
                            sb.filters.push([secondKey, secondValue]);
                            return { maybeSingle: () => Promise.resolve({ data: sb.single, error: null }) };
                        },
                        then: (fn: (r: unknown) => unknown) => Promise.resolve(fn({ data: sb.list, error: null })),
                    };
                },
            }),
        }),
    },
}));

import { announceCell, cellIdFor, fetchPublishedForecast, listPublishedModels } from '../services/weather/wxPublished';

beforeEach(() => {
    sb.upserts.length = 0;
    sb.single = null;
    sb.list = [];
    sb.filters = [];
    vi.useFakeTimers({ now: new Date('2026-10-16T12:30:00Z'), toFake: ['Date'] });
    localStorage.clear();
});
afterEach(() => vi.useRealTimers());

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
        const fixture = wxFixture();
        sb.single = { payload: fixture.payload, run_at: fixture.runAt.replace('Z', '+00:00') };
        const result = await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon');
        expect(result?.sampling).toBe('quarter-degree-cell');
        expect(result?.payload).toMatchObject({ current: { wind_speed_10m: 22 } });
        expect(sb.filters).toContainEqual(['model', 'wx2:dwd_icon']);
    });
    it('rejects a stale run — the live proxy is better than day-old data', async () => {
        sb.single = { payload: {}, run_at: new Date(Date.now() - 25 * 3_600_000).toISOString() };
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).toBeNull();
    });
    it('absence is silence, not an error', async () => {
        sb.single = null;
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).toBeNull();
    });
    it('does not accept legacy empty payloads or fine-model v2 rows', async () => {
        sb.single = { payload: {}, run_at: wxFixture().runAt };
        expect(await fetchPublishedForecast(-27.2, 153.1, 'dwd_icon')).toBeNull();
        sb.single = { payload: wxFixture().payload, run_at: wxFixture().runAt };
        expect(await fetchPublishedForecast(-27.2, 153.1, 'ecmwf_ifs')).toBeNull();
    });
    it('maps only recognised aliases, deduplicates, and rejects future/unknown versions', async () => {
        const valid = wxFixture().runAt;
        sb.list = [
            { model: 'wx2:dwd_icon', run_at: valid },
            { model: 'wx2:dwd_icon', run_at: valid },
            { model: 'wx2:ecmwf_ifs', run_at: valid },
            { model: 'wx3:dwd_icon', run_at: valid },
            { model: 'unknown', run_at: valid },
            { model: 'wx2:jma_gsm', run_at: '2026-10-16T15:00:00Z' },
        ];
        expect(await listPublishedModels(-27.2, 153.1)).toEqual(['dwd_icon']);
    });
});
