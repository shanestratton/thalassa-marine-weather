/**
 * The account-deletion write fence failed OPEN for the service role and for
 * direct database writes.
 *
 * block_tombstoned_account_write() decided scrub mode with
 * `auth.role() = 'service_role' AND current_setting('thalassa.account_deletion_scrub', true) = 'true'`.
 * In a backend that has never set the setting, current_setting(..., true) is
 * NULL, so the expression is NULL, `IF NOT scrub_mode AND ...` is NULL, and
 * IF treats NULL as false: the fence never raised. Signed-in clients were
 * still fenced (FALSE AND NULL is FALSE).
 *
 * Found 2026-10-05 by the Sightings rolled-back production replay (step 10b)
 * and reproduced on the live boats table. 20261005160000 makes it fail closed.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'supabase/migrations';
const FIX = '20261005160000_tombstone_fence_fails_closed.sql';
const fix = readFileSync(`${DIR}/${FIX}`, 'utf8');
const sql = (text: string) => text.replace(/--.*$/gm, '');

describe('the account-deletion fence fails closed', () => {
    it('treats an unset scrub setting as not scrubbing', () => {
        const body = sql(fix);
        expect(body).toMatch(
            /scrub_mode BOOLEAN := COALESCE\(\s*auth\.role\(\) = 'service_role'\s+AND current_setting\('thalassa\.account_deletion_scrub', true\) = 'true',\s*false\s*\);/,
        );
    });

    it('still raises 55000 for a tombstoned account outside scrub mode', () => {
        const body = sql(fix);
        expect(body).toContain('IF NOT scrub_mode AND EXISTS (');
        expect(body).toContain('SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate');
        expect(body).toContain("USING ERRCODE = '55000'");
    });

    it('keeps the definer hardening of the original', () => {
        const body = sql(fix);
        expect(body).toContain('SECURITY DEFINER');
        expect(body).toContain('SET search_path = pg_catalog, public');
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.block_tombstoned_account_write() FROM PUBLIC, anon, authenticated;',
        );
    });

    it('is the newest definition of the fence', () => {
        const definers = readdirSync(DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort()
            .filter((f) =>
                sql(readFileSync(`${DIR}/${f}`, 'utf8')).includes(
                    'CREATE OR REPLACE FUNCTION public.block_tombstoned_account_write()',
                ),
            );
        expect(definers[definers.length - 1]).toBe(FIX);
    });

    it('opens no transaction of its own', () => {
        const outsideBodies = sql(fix).replace(/\$\$[\s\S]*?\$\$/g, '');
        expect(outsideBodies).not.toMatch(/^\s*(BEGIN|COMMIT|END|ROLLBACK)\s*;/im);
    });
});
