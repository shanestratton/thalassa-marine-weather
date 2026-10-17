import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The cyclone watcher's tables, its status call and its cron job (129-09).
// Written with 129, NOT pushed: supabase db push applies every file in
// supabase/migrations, and this one waits until Shane has deployed send-push,
// cyclone-feed, fetch-gfs-tracker and cyclone-watch. Until then nothing answers, so the
// app keeps the switch hidden. It is released by moving it into
// supabase/migrations under a stamp newer than the newest applied one, and
// this test is rewritten in that same commit to read the released file and
// assert the held copy is gone (the b85cd258d vault-limits release).
const FILE = '20261014120000_cyclone_watch.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

describe('cyclone watch migration', () => {
    it('is held out of supabase/migrations, so the 129 release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('cyclone_watch'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261014120000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
    });

    it('keeps per-boat state and the run status private to the service role', () => {
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.cyclone_watch_alerts/);
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.cyclone_watch_status/);
        expect(sql).toMatch(/ALTER TABLE public\.cyclone_watch_alerts ENABLE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/ALTER TABLE public\.cyclone_watch_status ENABLE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/REVOKE ALL ON public\.cyclone_watch_alerts FROM PUBLIC, anon, authenticated/);
        expect(sql).toMatch(/REVOKE ALL ON public\.cyclone_watch_status FROM PUBLIC, anon, authenticated/);
        expect(sql).not.toMatch(/CREATE POLICY/);
        // No coordinates are stored: no lat/lon columns anywhere.
        expect(sql).not.toMatch(/\b(lat|lon|latitude|longitude)\b/i);
    });

    it('answers the app with when it last ran and whether its feed is down, nothing else', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.cyclone_watch_status()'));
        expect(fn).toMatch(/RETURNS TABLE \(ran_at timestamptz, unavailable_since timestamptz\)/);
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = pg_catalog, public/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.cyclone_watch_status\(\) FROM PUBLIC, anon/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.cyclone_watch_status\(\) TO authenticated/);
    });

    it('schedules cyclone-watch every 30 min on the vault credential path, the shore-watch way', () => {
        expect(sql).toContain("job_name CONSTANT TEXT := 'cyclone-watch';");
        expect(sql).toContain("want_schedule CONSTANT TEXT := '10,40 * * * *';");
        expect(sql).toContain(
            "want_command CONSTANT TEXT := 'SELECT public.invoke_edge_function(''cyclone-watch'', 150000)';",
        );
        expect(sql).toContain("RAISE NOTICE '% is paused; left paused.");
        expect(sql).toMatch(/to_regprocedure\('public\.invoke_edge_function\(text,integer,jsonb\)'\) IS NULL/);
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it('the function it schedules exists and guards itself as a cron entry point', () => {
        const edge = readFileSync('supabase/functions/cyclone-watch/index.ts', 'utf8');
        expect(edge).toContain('requireServiceRolePost(');
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(edge).toContain(".from('cyclone_watch_status')");
        expect(edge).toContain(".from('push_notification_queue')");
        // Positions are read inside the watcher only and never logged.
        expect(edge).not.toMatch(/console\.\w+\([^)]*\b(lat|lon|position)\b/);
    });

    it('gives runWatch each boat’s real clock and the feed’s gaps (129-09b), on the server only', () => {
        const edge = readFileSync('supabase/functions/cyclone-watch/index.ts', 'utf8');
        // Quiet hours on the IANA zone of the boat's position; without this one line they fall
        // back to the nautical clock and a Sydney boat in summer gets a notice at 22:30.
        expect(edge).toContain("import tzLookup from 'npm:tz-lookup@6.1.25';");
        expect(edge).toMatch(/runWatch\(\{[^}]*\bzoneAt: tzLookup\b[^}]*\}\)/);
        // A storm missing while part of the feed is down is "not answering", never "no longer in the feed".
        expect(edge).toContain('const partial = feedPartial(feed);');
        expect(edge).toMatch(/runWatch\(\{[^}]*\bpartial\b[^}]*\}\)/);
        // The lookup stays out of the app bundle.
        for (const app of ['services/weather/CycloneTrackingService.ts', 'components/map/useCycloneLayer.ts']) {
            expect(readFileSync(app, 'utf8')).not.toMatch(/tz-lookup/);
        }
    });
});
