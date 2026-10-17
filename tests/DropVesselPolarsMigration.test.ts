import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Drop the unused vessel_polars table (132-B22). Shane, 15 Oct: "drop the
// unused old vessel_polars table". The push needs his own Supabase sign-in,
// so it is written HELD: supabase db push applies every file in
// supabase/migrations. It is released by moving it into supabase/migrations
// under a stamp newer than the newest applied one, and this test is
// rewritten in that same commit to read the released file and assert the
// held copy is gone (the b85cd258d vault-limits release).
//
// Before it is dropped, nothing may read or write it: the last test walks the
// app, the Pi, the edge functions, the workers and the scripts for its name.
const FILE = '20261015200000_drop_vessel_polars.sql';
const ROOT = process.cwd();
const held = join(ROOT, 'supabase/held-migrations');
const release = join(ROOT, 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');

/** Where code that could read or write a table lives: the app, the Pi, the edge, the workers, the scripts. */
const CODE_DIRS = [
    'api',
    'backend',
    'bosun-pi',
    'cloudflare-worker',
    'components',
    'context',
    'contexts',
    'data',
    'hooks',
    'managers',
    'modules',
    'opencpn-bridge',
    'pages',
    'pi-cache',
    'scripts',
    'services',
    'src',
    'stores',
    'supabase/functions',
    'tools',
    'types',
    'utils',
    'vessel-scraper',
    'workers',
];
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|sh|sql|json|toml)$/i;
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '__pycache__']);

function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (CODE_FILE.test(entry)) out.push(full);
    }
    return out;
}

describe('drop vessel_polars migration (132-B22)', () => {
    it('is held out of supabase/migrations, so a release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('drop_vessel_polars'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261015200000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
        // Newer than the newest applied migration, and than every held file, when it was written.
        expect(FILE > '20261013091000_vessel_vault_limits.sql').toBe(true);
        expect(FILE > '20261015120000_maintenance_history_keeps_records.sql').toBe(true);
    });

    it('drops the table and its own trigger function, never with CASCADE', () => {
        expect(sql).toContain('DROP TABLE IF EXISTS public.vessel_polars;');
        expect(sql).toContain('DROP FUNCTION IF EXISTS public.vessel_polars_set_updated_at();');
        expect(sql).not.toMatch(/CASCADE/i);
        // Nothing else: no other table, column, policy or grant is touched.
        expect(sql.match(/\bDROP\b/gi)).toHaveLength(2);
        expect(sql).not.toMatch(/\b(ALTER|CREATE|GRANT|REVOKE|DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
    });

    it('refuses, dropping nothing, if a row was written after the app stopped writing it', () => {
        const check = sql.indexOf('DO $precheck$');
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(sql.indexOf('DROP TABLE'));
        expect(sql).toContain("IF to_regclass('public.vessel_polars') IS NULL THEN RETURN; END IF;");
        expect(sql).toContain(
            "WHERE created_at > TIMESTAMPTZ '2026-03-01 00:00:00+00' OR updated_at > TIMESTAMPTZ '2026-08-14 00:00:00+00';",
        );
        expect(sql).toMatch(/IF late_rows > 0 THEN RAISE EXCEPTION/);
    });

    it('is bounded on its lock, has no transaction of its own, and says how to undo it', () => {
        expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(migration).toMatch(/-- Undo\n/);
        expect(migration).toContain('20260723095000_vessel_polars.sql');
    });

    it('nothing in the app, the Pi, the edge functions, the workers or the scripts reads or writes vessel_polars', () => {
        const files = CODE_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
        // The walk reached each kind of code it vouches for.
        const seen = (prefix: string) => files.some((f) => relative(ROOT, f).replace(/\\/g, '/').startsWith(prefix));
        for (const prefix of [
            'services/',
            'components/',
            'bosun-pi/',
            'pi-cache/',
            'supabase/functions/',
            'workers/',
        ]) {
            expect(seen(prefix), prefix).toBe(true);
        }
        const naming = files
            .filter((f) => /vessel_polars/i.test(readFileSync(f, 'utf8')))
            .map((f) => relative(ROOT, f).replace(/\\/g, '/'));
        expect(naming).toEqual([]);
        for (const root of [
            'App.tsx',
            'ApplicationShell.tsx',
            'index.tsx',
            'viewRegistry.tsx',
            'utils.ts',
            'types.ts',
        ]) {
            expect(readFileSync(join(ROOT, root), 'utf8'), root).not.toMatch(/vessel_polars/i);
        }
    });
});
