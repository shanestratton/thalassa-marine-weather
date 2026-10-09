import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Shore Watch, build 126 (126-03b): the phone keeping an anchor watch checks
 * in with the server, the server tells the crew when it goes quiet, and a watch
 * lives while whatever keeps it (the phone or the Pi) is still checking in.
 *
 * Static pins on the migration. The behaviour itself is proved by the
 * rolled-back rehearsal recorded in the package's scratchpad.
 */
const FILE = '20261010130000_anchor_watch_keeper_heartbeat.sql';
const PATH = `supabase/migrations/${FILE}`;
const sql = existsSync(PATH) ? readFileSync(PATH, 'utf8') : '';
const executable = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const header = sql.slice(0, sql.indexOf('SET lock_timeout'));
/** The body of one CREATE OR REPLACE FUNCTION, up to its closing $$;. */
const fn = (name: string) => {
    const at = executable.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? '' : executable.slice(at, executable.indexOf('$$;', at));
};

describe('anchor watch keeper heartbeat migration (126-03b)', () => {
    it('exists, and sorts after every migration live today and every other 126 file', () => {
        const names = readdirSync('supabase/migrations').filter((n) => n.endsWith('.sql'));
        expect(names).toContain(FILE);
        // Live's newest on 2026-10-10 was 20261009172000; 126-04b took 20261010120000.
        expect(FILE > '20261009172000_saved_routes_verification.sql').toBe(true);
        expect(FILE > '20261010120000_pi_alarm_events.sql').toBe(true);
        expect(names.filter((n) => n.startsWith('20261010130000_'))).toEqual([FILE]);
    });

    it('sets a plain lock_timeout (SET LOCAL is a no-op outside a transaction block) and resets it', () => {
        expect(executable).toMatch(/^SET lock_timeout = '5s';$/m);
        expect(executable).not.toMatch(/SET LOCAL/i);
        expect(executable).toMatch(/^RESET lock_timeout;$/m);
    });

    it('adds the phone beat, its state, the one-shot flag and the error stamp, with a partial index', () => {
        expect(executable).toMatch(/ADD COLUMN IF NOT EXISTS vessel_heartbeat_at TIMESTAMPTZ/);
        expect(executable).toMatch(
            /ADD COLUMN IF NOT EXISTS vessel_state TEXT CHECK \(vessel_state IN \('watching', 'ended'\)\)/,
        );
        expect(executable).toMatch(/ADD COLUMN IF NOT EXISTS phone_quiet_alarm_at TIMESTAMPTZ/);
        expect(executable).toMatch(/ADD COLUMN IF NOT EXISTS last_error_sqlstate TEXT/);
        expect(executable).toMatch(
            /CREATE INDEX IF NOT EXISTS [a-z_]+[\s\S]{0,200}WHERE vessel_heartbeat_at IS NOT NULL/,
        );
        expect(executable).toMatch(
            /ADD COLUMN IF NOT EXISTS watchkeeper TEXT CHECK \(watchkeeper IS NULL OR watchkeeper IN \('pi', 'phone'\)\)/,
        );
    });

    it('does not change the alarm_kind CHECK: every shipped app reads an unknown kind as DRAG', () => {
        expect(executable).not.toMatch(/alarm_kind_check/);
        expect(executable).not.toMatch(/alarm_kind\s+IN\s*\(/i);
        expect(executable).not.toMatch(/'phone_quiet'|'boat_quiet'/);
    });

    it('lets a client claim to be the phone, never the Pi', () => {
        const policy = executable.slice(
            executable.indexOf('CREATE POLICY anchor_event_vessel_insert'),
            executable.indexOf(';', executable.indexOf('CREATE POLICY anchor_event_vessel_insert')),
        );
        expect(policy).toContain("(watchkeeper IS NULL OR watchkeeper = 'phone')");
        expect(policy).toContain('user_id = auth.uid()');
        expect(policy).toContain("m.role = 'vessel' AND s.expires_at > now()");
        expect(executable).toContain('DROP POLICY IF EXISTS anchor_event_vessel_insert ON public.anchor_alarm_events;');
        expect(executable).not.toMatch(/FOR ALL/i);
    });

    it('the heartbeat RPC is the owner phone only, signed in, bounded, rolling at most 23 hours ahead', () => {
        const rpc = fn('record_anchor_watch_heartbeat');
        expect(rpc).toContain('SECURITY DEFINER SET search_path = public');
        expect(rpc).toContain('auth.uid()');
        expect(rpc).toContain('owner_user_id');
        expect(rpc).toContain("'vessel'");
        expect(rpc).toContain("interval '20 seconds'");
        expect(rpc).toContain("GREATEST(expires_at, now() + interval '23 hours')");
        expect(rpc).toMatch(/expires_at <= now\(\)[\s\S]{0,40}RETURN NULL/);
        expect(rpc).toContain("watchkeeper = 'phone' AND alarm_kind = 'contact_lost'");
        expect(executable).toContain(
            'REVOKE ALL ON FUNCTION public.record_anchor_watch_heartbeat(TEXT, TEXT) FROM PUBLIC, anon;',
        );
        expect(executable).toContain(
            'GRANT EXECUTE ON FUNCTION public.record_anchor_watch_heartbeat(TEXT, TEXT) TO authenticated;',
        );
    });

    it('the phone watchdog pages once per outage after 5 minutes, as contact_lost from the phone', () => {
        const check = fn('check_anchor_phone_watch_health');
        expect(check).toContain("vessel_state = 'watching'");
        expect(check).toContain("vessel_heartbeat_at < now() - interval '5 minutes'");
        expect(check).toContain('phone_quiet_alarm_at IS NULL');
        expect(check).toContain('expires_at > now()');
        expect(check).toContain('FOR UPDATE OF s SKIP LOCKED');
        expect(check).toContain("'contact_lost', 'phone', 0, 0");
        expect(executable).toContain(
            'REVOKE ALL ON FUNCTION public.check_anchor_phone_watch_health() FROM PUBLIC, anon, authenticated;',
        );
    });

    it('runs each watch in its own EXCEPTION block that stamps the SQLSTATE, in both watchdogs', () => {
        for (const name of ['check_anchor_phone_watch_health', 'check_pi_anchor_watch_health']) {
            const body = fn(name);
            expect(body, name).toMatch(/LOOP\s+BEGIN/);
            expect(body, name).toContain('EXCEPTION WHEN OTHERS THEN');
            expect(body, name).toContain('failed_state := SQLSTATE;');
            expect(body, name).toContain('last_error_sqlstate = failed_state');
        }
    });

    it('raises the Pi lease cap to 7 days in the CHECK and the heartbeat, and rolls the session first', () => {
        expect(executable).toContain(
            'ALTER TABLE public.pi_anchor_sessions DROP CONSTRAINT IF EXISTS pi_anchor_sessions_expiry_bounded;',
        );
        expect(executable).toContain(
            "CHECK (expires_at > authorised_at AND expires_at <= authorised_at + INTERVAL '7 days')",
        );
        const heartbeat = fn('record_pi_anchor_heartbeat');
        expect(heartbeat).toContain("b.authorised_at + INTERVAL '7 days'");
        expect(heartbeat).not.toContain("interval '48 hours'");
        // The session rolls BEFORE hard_expiry is read, and never revives an expired one.
        const roll = heartbeat.indexOf("GREATEST(s.expires_at, now() + interval '23 hours')");
        expect(roll).toBeGreaterThan(-1);
        expect(roll).toBeLessThan(heartbeat.indexOf('INTO hard_expiry'));
        expect(heartbeat.slice(roll - 600, roll + 400)).toContain('s.expires_at > now()');
        expect(heartbeat).not.toContain('NEVER renewed');
        // Same signature as live: a Pi keeping a watch every 10 s is never refused.
        expect(executable).toContain(
            'REVOKE ALL ON FUNCTION public.record_pi_anchor_heartbeat(TEXT,TEXT,UUID,BOOLEAN,BOOLEAN,REAL,REAL,REAL,REAL) FROM PUBLIC, anon, authenticated;',
        );
    });

    it('warns "ends soon" 12 hours before the 7-day lease cap, once, instead of 15 minutes before the session', () => {
        const pi = fn('check_pi_anchor_watch_health');
        expect(pi).toContain("b.authorised_at + INTERVAL '7 days' <= now() + interval '12 hours'");
        expect(pi).toContain('b.expiry_alarm_at IS NULL');
        expect(pi).not.toContain("interval '15 minutes'");
        // Its contact_lost rule is today's, unchanged.
        expect(pi).toContain("COALESCE(b.last_heartbeat_at,b.authorised_at) < now() - interval '60 seconds'");
    });

    // Review 2026-10-10: a session no longer dies at 24 h, and that cap was all
    // that bounded the session code (a bearer credential) and the membership it
    // buys (live position, the channel, alarm events). Bound those, not the watch.
    it("admits newcomers by code only in a watch's first 24 hours; the owner and existing members always", () => {
        const join = fn('join_anchor_watch_session');
        expect(join).toContain('RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public');
        expect(join).toContain("s.created_at > now() - interval '24 hours'");
        expect(join).toContain('s.owner_user_id = auth.uid()');
        expect(join).toMatch(/EXISTS \(\s*SELECT 1 FROM public\.anchor_watch_members/);
        expect(join).toContain('s.expires_at > now()');
        // Unchanged: the same answer for an expired, unknown or closed code.
        expect(join).toContain('RETURN false;');
        expect(join).toContain("ON CONFLICT (session_code, user_id) DO UPDATE SET role = 'shore'");
    });

    it("lets crew give up their own membership on Leave, never the owner's, once no device of theirs is registered", () => {
        const leave = fn('leave_anchor_watch_session');
        expect(leave).toContain('SECURITY DEFINER SET search_path = public');
        expect(leave).toContain('m.user_id = auth.uid()');
        expect(leave).toContain('s.owner_user_id <> auth.uid()');
        expect(leave).toMatch(/FROM public\.anchor_alarm_tokens/);
        expect(leave).not.toMatch(/DELETE FROM public\.anchor_watch_sessions/);
        expect(executable).toContain(
            'REVOKE ALL ON FUNCTION public.leave_anchor_watch_session(TEXT) FROM PUBLIC, anon;',
        );
        expect(executable).toContain(
            'GRANT EXECUTE ON FUNCTION public.leave_anchor_watch_session(TEXT) TO authenticated;',
        );
    });

    it('resolves a standing "ends soon" once the skipper has re-authorised, so crew phones can see it answered', () => {
        const heartbeat = fn('record_pi_anchor_heartbeat');
        expect(heartbeat).toContain("(alarm_kind = 'session_expiring' AND b.expiry_alarm_at IS NULL)");
    });

    it("schedules its own minute job and never touches job 26 ('shore-watch-health')", () => {
        expect(executable).toContain("job_name CONSTANT TEXT := 'anchor-phone-watch-health';");
        expect(executable).toContain("want_schedule CONSTANT TEXT := '* * * * *';");
        expect(executable).toContain(
            "want_command CONSTANT TEXT := 'SELECT public.check_anchor_phone_watch_health()';",
        );
        expect(executable).not.toContain('shore-watch-health');
        expect(executable).not.toContain('queue_anchor_alarm_reminders');
        expect(executable).not.toMatch(/cron\.alter_job/);
        expect((executable.match(/cron\.schedule\(/g) ?? []).length).toBe(1);
        const body = executable.slice(executable.indexOf('DO $schedule$'), executable.indexOf('$schedule$;'));
        const pausedGuard = body.indexOf('IF paused > 0 THEN');
        expect(pausedGuard).toBeGreaterThan(-1);
        expect(pausedGuard).toBeLessThan(body.indexOf('cron.unschedule'));
        expect(body).toContain('IF total = 1 AND exact = 1 THEN\n        RETURN;');
        for (const m of executable.matchAll(/FROM cron\.job\b([^;]*)/g)) {
            expect(m[1]).toMatch(/WHERE jobname = job_name/);
        }
    });

    it('checks itself before it lets the push finish', () => {
        const check = executable.slice(executable.indexOf('DO $check$'), executable.indexOf('$check$;'));
        expect(check).toContain("'anchor_event_member_read', 'anchor_event_vessel_insert'");
        expect(check).toContain("'anchor_sessions_member_read'");
        expect(check).toContain('RAISE EXCEPTION');
        expect(check).toContain(
            "has_function_privilege('anon', 'public.record_anchor_watch_heartbeat(text, text)', 'EXECUTE')",
        );
        for (const name of ['join_anchor_watch_session', 'leave_anchor_watch_session']) {
            expect(check).toContain(`has_function_privilege('anon', 'public.${name}(text)', 'EXECUTE')`);
        }
        expect(check).toMatch(/prosrc LIKE '%24 hours%'/);
    });

    it('carries what it does, the behaviour by state, "Written, NOT pushed" and the OFF switch in its header', () => {
        expect(header).toContain('Written, NOT pushed');
        expect(header).toContain('Safe to re-run');
        expect(header).toContain("SELECT cron.unschedule('anchor-phone-watch-health');");
        expect(header).toContain('Behaviour, by state');
        // No ids, keys or project hosts in a public repo.
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|Bearer /);
        expect(sql).not.toMatch(/\.supabase\.co/);
    });
});
