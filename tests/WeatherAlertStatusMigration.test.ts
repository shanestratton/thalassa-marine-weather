import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The look-ahead check's status (129-07): one row per run, one row per
// account it read, and the call the app makes before it shows the look-ahead
// choice. Optional, and its own yes for Shane: written with 129, NOT pushed,
// because supabase db push applies every file in supabase/migrations and this
// one waits for the check-weather-alerts deploy. Until both are live nothing
// answers weather_alert_status(), so the app keeps the choice hidden. It is
// released by moving it into supabase/migrations under a stamp newer than the
// newest applied one, and this test is rewritten in that same commit to read
// the released file and assert the held copy is gone (the b85cd258d release).
const FILE = '20261014190000_weather_alert_status.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const edge = readFileSync('supabase/functions/check-weather-alerts/index.ts', 'utf8');

describe('weather alert status migration', () => {
    it('is held out of supabase/migrations, so the 129 release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('weather_alert_status'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261014190000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
    });

    it('keeps both tables private to the service role, and stores no position', () => {
        for (const table of ['weather_alert_status', 'weather_alert_runs']) {
            expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
            expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated;`);
        }
        expect(sql).not.toMatch(/CREATE POLICY/);
        expect(sql).not.toMatch(/\b(lat|lon|latitude|longitude|place|location)\b/i);
    });

    it('goes with the account: cascade on delete, and the account-deletion write fence', () => {
        expect(sql).toMatch(/user_id UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
        expect(sql).toMatch(
            /CREATE TRIGGER account_deletion_write_fence\s+BEFORE INSERT OR UPDATE ON public\.weather_alert_status\s+FOR EACH ROW EXECUTE FUNCTION public\.block_tombstoned_account_write\('user_id'\)/,
        );
        expect(sql).toMatch(/to_regprocedure\('public\.block_tombstoned_account_write\(\)'\) IS NULL/);
    });

    it('bounds what a status row can hold: a short list of lines, and the two bases', () => {
        expect(sql).toMatch(/jsonb_typeof\(lines\) = 'array'/);
        expect(sql).toMatch(/jsonb_array_length\(lines\) <= 12/);
        expect(sql).toMatch(/octet_length\(lines::text\) <= 4096/);
        expect(sql).toMatch(/basis IN \('saved', 'last-known'\)/);
        expect(sql).toMatch(
            /CREATE TABLE IF NOT EXISTS public\.weather_alert_runs \(\s*id SMALLINT PRIMARY KEY CHECK \(id = 1\)/,
        );
    });

    it('answers the app with the run’s version and time and the caller’s own lines, nothing else', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.weather_alert_status()'));
        expect(fn).toMatch(/RETURNS TABLE \(version smallint, ran_at timestamptz, basis text, lines jsonb\)/);
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = pg_catalog, public/);
        expect(fn).toMatch(/s\.user_id = auth\.uid\(\)/);
        expect(fn).toMatch(/WHERE r\.id = 1/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.weather_alert_status\(\) FROM PUBLIC, anon;/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.weather_alert_status\(\) TO authenticated;/);
    });

    it('leaves the check-weather-alerts cron job alone, and runs again as a no-op', () => {
        expect(sql).not.toMatch(/cron\./);
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(sql).toMatch(/SET lock_timeout = '5s';/);
        expect(sql).toMatch(/RESET lock_timeout;/);
        expect(migration).toMatch(/Undo/);
    });

    it('is what the function writes: its version each run, and only lines that changed', () => {
        expect(edge).toContain(".from('weather_alert_runs')");
        expect(edge).toContain(".from('weather_alert_status')");
        expect(edge).toContain('version: FORECAST_ALERTS_VERSION');
        // Status rows are read first and only changed ones are written: no row churn every 30 min.
        expect(edge).toMatch(/\.select\('user_id, basis, lines'\)/);
        // A missing table (the migration not pushed yet) costs a warning, never the run.
        expect(edge).toMatch(/weather_alert_status is not there yet/);
    });
});
