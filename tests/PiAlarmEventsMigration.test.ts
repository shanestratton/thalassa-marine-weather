/**
 * The Pi's alarms in the cloud (build 126, package 126-04b): pi_alarm_events
 * and acknowledge_pi_alarm.
 *
 * pi-alarm-relay (the Pi, with its pairing credential, through the service
 * role) keeps one row per (relay, alarm key) so the re-send rules and the
 * caps are the server's, and so an acknowledgement made ashore reaches the
 * Pi in the relay's answer. The skipper reads his own rows (a phone that was
 * asleep shows the open ones as cards 'from the Pi') and acknowledges one
 * through the RPC. Nothing else: no client writes, no anon, nobody else's.
 *
 * Supabase grants anon and authenticated every privilege on a NEW public
 * table by default (pg_default_acl, still open on 2026-10-09), so the file
 * revokes explicitly and checks itself before it commits. The behaviour was
 * replayed on live inside rolled-back transactions; these pin the shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const files = readdirSync(DIR).filter((f) => f.endsWith('_pi_alarm_events.sql'));
const FILE = files[0] ?? '';
const sql = FILE ? readFileSync(`${DIR}/${FILE}`, 'utf8') : '';
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const code = sql.replace(/--[^\n]*\n/g, '\n');
const body = squash(code);

const between = (start: string, end = '$$;') => {
    const from = body.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThanOrEqual(0);
    const to = body.indexOf(end, from + start.length);
    expect(to).toBeGreaterThan(from);
    return body.slice(from, to + end.length);
};

/** The key the relay and the RPC accept, read out of the CHECK so the two can never drift. */
function keyPattern(): RegExp {
    const m = body.match(/alarm_key ~ '([^']+)'/);
    expect(m, 'the alarm_key CHECK').not.toBeNull();
    return new RegExp(m![1]);
}

describe('pi_alarm_events migration', () => {
    it('is one file, stamped after the newest migration live when it was written', () => {
        expect(files).toHaveLength(1);
        expect(FILE > '20261009172000_saved_routes_verification.sql').toBe(true);
    });

    it('runs in one transaction with its lock timeout inside it', () => {
        const statements = code.trim();
        expect(statements.startsWith('BEGIN;')).toBe(true);
        expect(statements.endsWith('COMMIT;')).toBe(true);
        expect(body.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(body.indexOf('BEGIN;'));
        expect(body.match(/\bBEGIN;/g)).toHaveLength(1);
        expect(body.match(/\bCOMMIT;/g)).toHaveLength(1);
    });

    it('holds one row per (relay, alarm key), the owner’s, bounded', () => {
        const table = between('CREATE TABLE IF NOT EXISTS public.pi_alarm_events (', ');');
        expect(table).toContain('owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(table).toContain("relay_id TEXT NOT NULL CHECK (relay_id ~ '^[A-Za-z0-9_-]{16,128}$')");
        expect(table).toContain('char_length(alarm_key) <= 64');
        expect(table).toContain(
            "kind TEXT NOT NULL CHECK (kind IN ('collision', 'close-quarters', 'distress', 'blind', 'no-fix', 'test'))",
        );
        expect(table).toContain('mmsi INTEGER CHECK (mmsi IS NULL OR (mmsi >= 1000000 AND mmsi < 1000000000))');
        expect(table).toContain("payload JSONB NOT NULL DEFAULT '{}'::jsonb");
        expect(table).toContain('pg_column_size(payload) <= 2048');
        expect(table).toContain('pushed_count INTEGER NOT NULL DEFAULT 0 CHECK (pushed_count BETWEEN 0 AND 100)');
        expect(table).toContain('acked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL');
        expect(table).toContain('UNIQUE (relay_id, alarm_key)');
        expect(table).toContain("CHECK (split_part(alarm_key, ':', 1) = kind)");
        for (const column of ['raised_at', 'last_seen_at', 'last_pushed_at', 'acked_at', 'resolved_at']) {
            expect(table).toContain(`${column} TIMESTAMPTZ`);
        }
        expect(body).toContain(
            'CREATE INDEX IF NOT EXISTS pi_alarm_events_owner_raised_idx ON public.pi_alarm_events (owner_id, raised_at DESC);',
        );
    });

    it('the CHECK refuses a key that is not an alarm key', () => {
        const re = keyPattern();
        for (const good of [
            'collision:211000001:1760026440000',
            'close-quarters:366000002:1760026440000',
            'distress:970000003:1760026440000',
            'blind::1760026440000',
            'no-fix::1760026440000',
            'test::1760026440000',
        ]) {
            expect(re.test(good), good).toBe(true);
        }
        for (const bad of [
            'collision:211000001',
            'collision:211000001:12',
            'Collision:211000001:1760026440000',
            'collision:2110000011:1760026440000',
            "collision:211000001:1760026440000'; drop table x",
            'shout::1760026440000',
            '',
        ]) {
            expect(re.test(bad), bad).toBe(false);
        }
    });

    it('anon has nothing; authenticated may only SELECT, and only its own rows', () => {
        expect(body).toContain('ALTER TABLE public.pi_alarm_events ENABLE ROW LEVEL SECURITY;');
        expect(body).toContain('REVOKE ALL ON TABLE public.pi_alarm_events FROM PUBLIC, anon, authenticated;');
        expect(body).toContain('GRANT SELECT ON TABLE public.pi_alarm_events TO authenticated;');
        const grants = body.match(/GRANT [^;]*ON TABLE public\.pi_alarm_events[^;]*;/g) ?? [];
        expect(grants.sort()).toEqual(
            [
                'GRANT SELECT ON TABLE public.pi_alarm_events TO authenticated;',
                'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pi_alarm_events TO service_role;',
            ].sort(),
        );
        expect(body).not.toMatch(/GRANT [^;]*TO [^;]*\banon\b/);
        const policies = body.match(/CREATE POLICY [^;]*;/g) ?? [];
        expect(policies).toEqual([
            'CREATE POLICY pi_alarm_events_owner_read ON public.pi_alarm_events FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));',
        ]);
    });

    it('acknowledge_pi_alarm: definer, search_path pinned, the caller’s own rows, idempotent', () => {
        const fn = between('CREATE OR REPLACE FUNCTION public.acknowledge_pi_alarm(p_alarm_key TEXT)');
        expect(fn).toContain('SECURITY DEFINER');
        expect(fn).toContain('SET search_path = public, pg_temp');
        expect(fn).toContain('caller UUID := auth.uid();');
        expect(fn).toContain(
            "IF caller IS NULL THEN RAISE EXCEPTION 'sign in to acknowledge' USING ERRCODE = '42501';",
        );
        // Only an alarm a phone can show: never a notice or a test.
        expect(fn).toContain("p_alarm_key !~ '^(collision|close-quarters|distress):[0-9]{7,9}:[0-9]{10,13}$'");
        expect(fn).toContain('WHERE owner_id = caller AND alarm_key = p_alarm_key AND resolved_at IS NULL');
        // The first acknowledgement stands: a second tap changes nothing.
        expect(fn).toContain('SET acked_at = COALESCE(acked_at, now()), acked_by = COALESCE(acked_by, caller)');
        expect(body).toContain('REVOKE ALL ON FUNCTION public.acknowledge_pi_alarm(TEXT) FROM PUBLIC, anon;');
        expect(body).toContain('GRANT EXECUTE ON FUNCTION public.acknowledge_pi_alarm(TEXT) TO authenticated;');
    });

    it('fails the push unless the table, its grants, its policy and the RPC are exactly as stated', () => {
        const check = between('DO $check$', '$check$;');
        expect(check).toContain("RAISE EXCEPTION 'pi_alarm_events: RLS is off'");
        for (const role of ['anon', 'public']) expect(check).toContain(`'${role}'`);
        expect(check).toContain("has_function_privilege('anon', 'public.acknowledge_pi_alarm(text)', 'EXECUTE')");
        expect(check).toContain(
            "has_function_privilege('authenticated', 'public.acknowledge_pi_alarm(text)', 'EXECUTE')",
        );
        expect(check).toContain('prosecdef');
        expect(check).toContain('proconfig');
        expect(check).toContain("policyname <> 'pi_alarm_events_owner_read'");
    });

    it('safe to re-run, writes no rows and carries no ids or vessels', () => {
        expect(body).toContain('CREATE TABLE IF NOT EXISTS public.pi_alarm_events');
        expect(body).toContain('DROP POLICY IF EXISTS pi_alarm_events_owner_read ON public.pi_alarm_events;');
        expect(body).not.toMatch(/INSERT INTO/i);
        expect(body).not.toMatch(/net\.http_post|pg_notify|cron\.schedule/i);
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(code).not.toMatch(/\b\d{9}\b/); // no MMSI outside comments
    });

    it('passes the migration audit', () => {
        const out = execFileSync(process.execPath, ['scripts/audit-supabase-migrations.mjs'], { encoding: 'utf8' });
        expect(out).toContain('Supabase migration audit passed');
    });
});
