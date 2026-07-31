/**
 * chat_profiles is the one table in this schema whose client SELECT is an
 * EXPLICIT COLUMN GRANT rather than a table grant, so it has a failure mode no
 * other table has — and it shipped.
 *
 * 20260730130000_chat_profiles_column_grants.sql revoked the table-level SELECT
 * and re-granted a 10-column list, to stop `stripe_account_id` being readable by
 * every signed-in user. PostgreSQL treats a `t.*` target list as "SELECT on
 * every column", and PostgREST emits `select=*` as `"public"."chat_profiles".*`
 * — so `.select('*')` began failing 42501 for anon AND authenticated the moment
 * that migration applied. Verified against production: `select=*` → 401/42501,
 * the explicit list → 200.
 *
 * ProfilePhotoService.getProfile did exactly that, and discarded the error, so
 * the Scuttlebutt profile editor silently rendered blank — and saving those
 * blanks wrote them back, opting the user out of Lonely Hearts.
 *
 * The migration that caused it was verified by probing NAMED columns, which is
 * precisely the case that still worked. These tests probe the case that broke.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260730130000_chat_profiles_column_grants.sql');

/** Columns in the migration's `GRANT SELECT (...) ON public.chat_profiles`. */
function grantedColumns(): string[] {
    const sql = readFileSync(MIGRATION, 'utf8');
    const m = sql.match(/GRANT\s+SELECT\s*\(([^)]+)\)\s*ON\s+public\.chat_profiles/i);
    if (!m) throw new Error('could not find the column GRANT in the migration — was it renamed?');
    return m[1]
        .split(',')
        .map((c) => c.replace(/--.*$/gm, '').trim())
        .filter(Boolean)
        .sort();
}

/** Columns the service asks PostgREST for. */
function requestedColumns(): string[] {
    const src = readFileSync(join(ROOT, 'services', 'ProfilePhotoService.ts'), 'utf8');
    const m = src.match(/const PROFILE_COLUMNS\s*=\s*\n?\s*'([^']+)'/);
    if (!m) throw new Error('PROFILE_COLUMNS not found in ProfilePhotoService.ts');
    return m[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .sort();
}

describe('chat_profiles column-grant contract', () => {
    it('the columns the client requests are exactly the columns the migration grants', () => {
        expect(requestedColumns()).toEqual(grantedColumns());
    });

    it('never grants stripe_account_id back to clients', () => {
        expect(grantedColumns()).not.toContain('stripe_account_id');
        expect(requestedColumns()).not.toContain('stripe_account_id');
    });

    it('no client query uses select(*) on chat_profiles — it is a guaranteed 42501', () => {
        const offenders: string[] = [];

        // Every source dir a Supabase client call can live in.
        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                const p = join(dir, e.name);
                if (e.isDirectory()) out.push(...walk(p));
                else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
            }
            return out;
        };

        for (const dir of ['services', 'components', 'hooks', 'stores', 'pages', 'modules']) {
            let files: string[];
            try {
                files = walk(join(ROOT, dir));
            } catch {
                continue; // directory may not exist
            }
            for (const file of files) {
                const src = readFileSync(file, 'utf8');
                if (!/chat_profiles|PROFILES_TABLE/.test(src)) continue;

                // `.from(<chat_profiles-ish>)` followed by `.select('*')`, allowing
                // the chained calls and whitespace the real call sites use.
                const re =
                    /\.from\(\s*(?:PROFILES_TABLE|['"]chat_profiles['"])\s*\)[\s\S]{0,120}?\.select\(\s*['"]\s*\*\s*['"]\s*\)/g;
                for (const hit of src.matchAll(re)) {
                    const line = src.slice(0, hit.index).split('\n').length;
                    offenders.push(`${file.replace(`${ROOT}/`, '')}:${line}`);
                }
            }
        }

        expect(offenders, `select('*') on chat_profiles fails 42501 — use PROFILE_COLUMNS`).toEqual([]);
    });
});
