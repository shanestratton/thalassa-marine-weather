// @vitest-environment node
/**
 * Thalassa's own subdomain names can never be a boat's handle: one list in
 * TypeScript (src/publicHosts.ts) and one in SQL (the CHECK's function in
 * 20261006120000_ocean_public_read.sql), kept equal here; the app skips them
 * when it derives a personal handle and retries on the server's refusal; and
 * the voyage-log renderer never reads one as a boat.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    isReservedHandle,
    isReservedHandleRefusal,
    RESERVED_HANDLE_CONSTRAINT,
    RESERVED_HANDLES,
} from '../../src/publicHosts';

const MIGRATION = 'supabase/migrations/20261006120000_ocean_public_read.sql';
const sql = readFileSync(MIGRATION, 'utf8');

function sqlList(): string[] {
    const body = sql.match(
        /FUNCTION public\.voyage_log_handle_reserved\(p_handle TEXT\)[\s\S]*?ARRAY\[([\s\S]*?)\]::TEXT\[\]/,
    );
    expect(body, 'the reserved ARRAY in the migration').not.toBeNull();
    return [...(body as RegExpMatchArray)[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

afterEach(() => vi.unstubAllGlobals());

describe('reserved handles', () => {
    it('the TypeScript and SQL lists are the same names', () => {
        expect([...sqlList()].sort()).toEqual([...RESERVED_HANDLES].sort());
        expect(new Set(RESERVED_HANDLES).size).toBe(RESERVED_HANDLES.length);
        expect(RESERVED_HANDLES).toEqual(
            expect.arrayContaining(['ocean', 'watch', 'tiles', 'api', 'sightings', 'seabed', 'www', 'app']),
        );
    });

    it('compares lowercase and trimmed, like the SQL', () => {
        expect(isReservedHandle(' Ocean ')).toBe(true);
        expect(isReservedHandle('WWW')).toBe(true);
        expect(isReservedHandle('ocean-2')).toBe(false);
        expect(isReservedHandle('serene-summer')).toBe(false);
        expect(isReservedHandle(null)).toBe(false);
        expect(sql).toMatch(/lower\(btrim\(COALESCE\(p_handle, ''\)\)\)/);
    });

    it('names the server CHECK the app recognises', () => {
        expect(sql).toContain(`ADD CONSTRAINT ${RESERVED_HANDLE_CONSTRAINT}`);
        expect(
            isReservedHandleRefusal({
                code: '23514',
                message: `new row for relation "voyage_log_configs" violates check constraint "${RESERVED_HANDLE_CONSTRAINT}"`,
            }),
        ).toBe(true);
        // Another CHECK (scope, track_days) is a real error, not a retry.
        expect(
            isReservedHandleRefusal({
                code: '23514',
                message: 'violates check constraint "voyage_log_configs_scope_check"',
            }),
        ).toBe(false);
        expect(isReservedHandleRefusal({ code: '23505', message: RESERVED_HANDLE_CONSTRAINT })).toBe(false);
    });

    it('the personal-handle loop skips reserved names and retries on the refusal', () => {
        const tab = readFileSync('components/settings/VoyageLogTab.tsx', 'utf8');
        const loop = tab.slice(
            tab.indexOf('let candidate = base;'),
            tab.indexOf("toast.error('Could not pick a unique handle"),
        );
        expect(loop).toMatch(
            /if \(isReservedHandle\(candidate\)\) \{\s*attempt \+= 1;\s*candidate = `\$\{base\}-\$\{attempt\}`;\s*continue;/,
        );
        expect(loop).toContain("if (error.code !== '23505' && !isReservedHandleRefusal(error)) {");
        expect(loop.indexOf('isReservedHandle(candidate)')).toBeLessThan(
            loop.indexOf(".from('voyage_log_configs').insert("),
        );
    });

    it('the voyage-log renderer never reads a reserved label as a boat', async () => {
        const { parseVoyageLogParams } = await import('../../src/voyageLogApi');
        const at = (hostname: string, pathname = '/') =>
            vi.stubGlobal('window', { location: { hostname, pathname, search: '' } });
        at('ocean.thalassawx.app');
        expect(parseVoyageLogParams().handle).toBe('');
        at('www.thalassawx.com');
        expect(parseVoyageLogParams().handle).toBe('');
        at('api.thalassawx.app', '/logs/fixture-boat');
        expect(parseVoyageLogParams().handle).toBe('fixture-boat');
        at('fixture-boat.thalassawx.app');
        expect(parseVoyageLogParams().handle).toBe('fixture-boat');
    });

    it('the derive trigger skips reserved names, sees every boat, and still leaves explicit handles to the CHECK', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.voyage_log_set_handle()'));
        const body = fn.slice(0, fn.indexOf('$$;'));
        expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public, pg_temp/);
        expect(body).toMatch(
            /WHILE public\.voyage_log_handle_reserved\(candidate\)\s+OR EXISTS \(SELECT 1 FROM public\.voyage_log_configs WHERE handle = candidate\) LOOP/,
        );
        expect(body).toMatch(/IF NEW\.handle IS NOT NULL AND NEW\.handle <> '' THEN\s+RETURN NEW;/);
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.voyage_log_set_handle\(\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(
            /CHECK \(handle IS NULL OR NOT public\.voyage_log_handle_reserved\(handle\)\) NOT VALID;[\s\S]*VALIDATE CONSTRAINT voyage_log_configs_handle_not_reserved;/,
        );
        expect(sql).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.voyage_log_handle_reserved\(TEXT\) TO anon, authenticated, service_role;/,
        );
    });
});
