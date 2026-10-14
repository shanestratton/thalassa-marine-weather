/**
 * The 'boat went quiet' watchdog, part 2 (129-08): crew with Share Instrument
 * Panel paged with the owner, two honest messages, one all-clear, the weekly
 * window's 10-minute allowance and the flap guard. HELD in
 * supabase/held-migrations until Shane deploys send-push and says yes.
 *
 * The SQL cannot run here (no database may be touched, no local PostgreSQL).
 * These pin its text: the constants, the verdict order and the predicates are
 * the ones tests/helpers/boatQuietModel.ts implements, and
 * tests/BoatQuietWatchModel.test.ts runs that model over the cases a
 * rolled-back replay is to run unchanged (tests/fixtures/boat-quiet/cases.json).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    GRACE_MIN_DEFAULT,
    MAX_RECIPIENTS,
    PI_ANSWERS_WITHIN_MIN,
    SETTLE_MIN,
    WINDOW_ALLOWANCE_MIN,
} from './helpers/boatQuietModel';

const FILE = 'supabase/held-migrations/20261014180000_vessel_quiet_watch_crew.sql';
const sql = readFileSync(FILE, 'utf8');
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

const beforeWrite = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_before_write()');
const qualifies = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_crew_qualifies(');
const recipients = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_recipients(');
const boatName = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_boat_name(');
const allowance = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_window_allowance(');
const verdict = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_verdict(');
const words = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_message(');
const watchdog = between('CREATE OR REPLACE FUNCTION public.check_vessel_quiet_watch()');
const crewBoats = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_crew_boats()');
const switchedOff = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_after_switch_off()');
const setPage = between('CREATE OR REPLACE FUNCTION public.set_vessel_quiet_watch_crew_page(');

/** Quotes, dollar quotes, comments and brackets balanced; every top-level statement ends in ';'. */
function balanced(text: string): string | null {
    let depth = 0;
    for (let i = 0; i < text.length; ) {
        const rest = text.slice(i);
        if (rest.startsWith('--')) {
            const nl = text.indexOf('\n', i);
            i = nl < 0 ? text.length : nl + 1;
            continue;
        }
        if (text[i] === "'") {
            let j = i + 1;
            for (;;) {
                const q = text.indexOf("'", j);
                if (q < 0) return `open string at ${i}`;
                if (text[q + 1] === "'") j = q + 2;
                else {
                    i = q + 1;
                    break;
                }
            }
            continue;
        }
        const dollar = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest);
        if (dollar && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
            const end = text.indexOf(dollar[0], i + dollar[0].length);
            if (end < 0) return `open ${dollar[0]} at ${i}`;
            i = end + dollar[0].length;
            continue;
        }
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        if (depth < 0) return `unbalanced ) at ${i}`;
        i++;
    }
    return depth === 0 ? null : 'unbalanced (';
}

describe('vessel_quiet_watch_crew (held)', () => {
    it('is well formed, and passes the repo’s migration audit as if released', () => {
        expect(balanced(sql)).toBeNull();
        const dir = mkdtempSync(join(tmpdir(), 'quiet-watch-crew-audit-'));
        try {
            mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
            copyFileSync(FILE, join(dir, 'supabase/migrations', '20261014180000_vessel_quiet_watch_crew.sql'));
            const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/audit-supabase-migrations.mjs')], {
                cwd: dir,
                encoding: 'utf8',
            });
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('Supabase migration audit passed (1 files).');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        // Every definer pins its search_path.
        const definers = body.match(/SECURITY DEFINER SET search_path = [a-z_, ]+ AS/g) ?? [];
        expect(definers).toHaveLength((body.match(/SECURITY DEFINER/g) ?? []).length);
        // The replay script runs the same cases through the SQL.
        expect(readFileSync('scripts/check-boat-quiet-db.mjs', 'utf8')).toContain(
            'tests/fixtures/boat-quiet/cases.json',
        );
    });

    it('is held, newer than everything applied, and never in supabase/migrations', () => {
        expect(existsSync('supabase/migrations/20261014180000_vessel_quiet_watch_crew.sql')).toBe(false);
        expect(sql).toMatch(/^-- [^\n]*\n--[^\n]*\n--\n-- HELD\./);
        expect('20261014180000' > '20261014160000_official_alerts_watch').toBe(true);
        expect(body).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(body).toContain("SET lock_timeout = '5s';");
        expect(body.trim().endsWith('RESET lock_timeout;')).toBe(true);
        // The precheck refuses to run without 125's table and the deletion fence.
        expect(body).toContain("IF to_regclass('public.vessel_quiet_watch') IS NULL THEN RAISE EXCEPTION");
        expect(body).toContain("to_regprocedure('public.block_tombstoned_account_write()') IS NULL");
    });

    it('carries no ids, positions or real boat, and switches nothing on', () => {
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/\b\d{9}\b/); // no MMSI
        expect(sql).not.toMatch(/Serene Summer|Calypso|Newport/i);
        expect(body).not.toMatch(/INSERT INTO public\.vessel_quiet_watch\b/i);
        expect(body).not.toMatch(/UPDATE public\.vessel_quiet_watch SET enabled/i);
        // No position is read for, or put in, a push.
        expect(watchdog).not.toMatch(/\bt\.lat\b|\bt\.lon\b|'lat'|'lon'/);
        // It touches no cron job: the every-minute job already calls the replaced function.
        expect(code).not.toMatch(/cron\./);
    });

    it('adds four watchdog-only columns no client grant reaches, and clears them on switch-on and switch-off', () => {
        for (const column of [
            'paged_kind TEXT',
            'paged_bus_at TIMESTAMPTZ',
            'paged_recipients UUID[]',
            'cleared_at TIMESTAMPTZ',
        ]) {
            expect(body).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
        }
        expect(body).toContain("CHECK (paged_kind IS NULL OR paged_kind IN ('pi_offline', 'instruments_silent'))");
        expect(body).toContain(
            `CHECK (paged_recipients IS NULL OR cardinality(paged_recipients) <= ${MAX_RECIPIENTS})`,
        );
        expect(body).not.toMatch(/GRANT [^;]*ON TABLE public\.vessel_quiet_watch\b/);
        for (const column of ['paged_bus_at', 'paged_kind', 'paged_recipients', 'cleared_at']) {
            expect(beforeWrite).toContain(`NEW.${column} := NULL;`);
        }
        expect(beforeWrite).toContain(
            "IF (NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled)) OR NOT NEW.enabled THEN NEW.armed_at := CASE WHEN NEW.enabled THEN now() END;",
        );
        expect(beforeWrite).toContain("IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN");
        expect(beforeWrite).toContain('pg_catalog.pg_timezone_names AS zone WHERE zone.name = NEW.window_tz');
        expect(beforeWrite).not.toContain('SECURITY DEFINER');
    });

    it('keeps a crew member’s opt-out per boat, behind RLS with no client grant, fenced and removed with either account', () => {
        expect(body).toContain(
            'CREATE TABLE IF NOT EXISTS public.vessel_quiet_watch_optouts ( user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,',
        );
        expect(body).toContain('PRIMARY KEY (user_id, owner_id)');
        expect(body).toContain('ALTER TABLE public.vessel_quiet_watch_optouts ENABLE ROW LEVEL SECURITY;');
        expect(body).toContain(
            'REVOKE ALL ON TABLE public.vessel_quiet_watch_optouts FROM PUBLIC, anon, authenticated;',
        );
        expect(body).not.toMatch(/GRANT [^;]*ON TABLE public\.vessel_quiet_watch_optouts/);
        expect(body).not.toMatch(/CREATE POLICY [^;]*vessel_quiet_watch_optouts/);
        expect(body).toContain(
            "BEFORE INSERT OR UPDATE ON public.vessel_quiet_watch_optouts FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');",
        );
    });

    it('pages accepted crew with Share Instrument Panel, never pending, declined, guests or the owner twice', () => {
        // The very flag vessel_telemetry_crew_reads checks (20260907140000).
        expect(qualifies).toContain("membership.status = 'accepted'");
        expect(qualifies).toContain("membership.role IS DISTINCT FROM 'punter'");
        expect(qualifies).toContain("COALESCE((membership.permissions ->> 'can_view_instruments')::boolean, false)");
        expect(qualifies).toContain('p_user_id <> p_owner_id');
        expect(qualifies).not.toContain('SECURITY DEFINER');
        // The owner first, opted-out and deleting accounts out, at most 64.
        expect(recipients).toContain('SELECT p_owner_id AS recipient, true AS is_owner UNION');
        expect(recipients).toContain('public.vessel_quiet_watch_crew_qualifies(p_owner_id, membership.crew_user_id)');
        expect(recipients).toContain(
            'NOT EXISTS ( SELECT 1 FROM public.vessel_quiet_watch_optouts AS optout WHERE optout.user_id = membership.crew_user_id AND optout.owner_id = p_owner_id )',
        );
        expect(recipients).toContain(
            'SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = candidate.recipient',
        );
        expect(recipients).toContain(`ORDER BY candidate.is_owner DESC, candidate.recipient LIMIT ${MAX_RECIPIENTS}`);
        expect(recipients).not.toMatch(/boat_members|'pending'|'declined'/);
    });

    it('names her from her own boats only, 60 characters at most, control characters out', () => {
        expect(boatName).toContain("NULLIF(btrim(regexp_replace(left(boat.name, 60), '[[:cntrl:]]', '', 'g')), '')");
        expect(boatName).toContain('WHERE boat.owner_id = p_owner_id');
        expect(boatName).toContain('telemetry.boat_id FROM public.vessel_telemetry AS telemetry');
        expect(boatName).toContain('active.boat_id FROM public.user_active_vessels AS active');
    });

    it('forgives at most 10 minutes of the latest window, in the vessel’s own zone, across midnight', () => {
        expect(allowance).toContain(`LEAST( interval '${WINDOW_ALLOWANCE_MIN} minutes',`);
        expect(allowance).toContain("GREATEST(interval '0', LEAST(p_now, closes_at) - GREATEST(p_from, opened_at))");
        expect(allowance).toContain('SELECT p_now AT TIME ZONE p_window_tz AS local_now');
        expect(allowance).toContain(
            '(local_now::date - ((EXTRACT(DOW FROM local_now)::int - p_window_dow + 7) % 7)) + p_window_start AS opens_local',
        );
        expect(allowance).toContain(
            "CASE WHEN opens_local > local_now THEN opens_local - interval '7 days' ELSE opens_local END AS opened_local",
        );
        expect(allowance).toContain("ELSE p_window_end - p_window_start + interval '24 hours'");
        const zones = [...body.matchAll(/AT TIME ZONE ([^\s)]+)/g)].map((m) => m[1]);
        expect(new Set(zones)).toEqual(new Set(['p_window_tz']));
        expect(code).not.toMatch(/Australia\/|Brisbane|AEST|AEDT|UTC\+|'\+10'|interval '10 hours'/);
    });

    it('decides in the order the model does, with the model’s constants', () => {
        expect(verdict).toMatch(
            /RETURNS TEXT LANGUAGE sql STABLE SET search_path = pg_catalog, public AS \$\$ WITH settled AS/,
        );
        expect(verdict).not.toContain('SECURITY DEFINER');
        expect(verdict).toContain(
            `make_interval(mins => COALESCE(p_quiet_after_minutes, ${GRACE_MIN_DEFAULT})) AS grace`,
        );
        expect(verdict).toContain(
            `COALESCE(p_cleared_at > p_now - interval '${SETTLE_MIN} minutes', false) AS settling`,
        );
        expect(verdict).toContain(
            'GREATEST(p_last_heard_at, p_armed_at, CASE WHEN settled.settling THEN p_cleared_at END) AS pi_from',
        );
        expect(verdict).toContain(
            'GREATEST(p_bus_at, p_armed_at, CASE WHEN settled.settling THEN p_cleared_at END) AS bus_from',
        );
        // No window allowance while settling after an all-clear: the full grace again.
        expect(
            verdict.match(
                /CASE WHEN starts\.settling THEN interval '0' ELSE public\.vessel_quiet_watch_window_allowance\(/g,
            ),
        ).toHaveLength(2);
        expect(verdict).toContain(`AND p_now - p_last_heard_at <= interval '${PI_ANSWERS_WITHIN_MIN} minutes'`);
        expect(verdict).toContain(
            "AND COALESCE(p_bus_at, p_last_heard_at) > COALESCE(p_paged_bus_at, '-infinity'::timestamptz) THEN 'recovered'",
        );
        const order = [
            "THEN 'off'",
            "THEN 'never_heard'",
            "THEN 'recovered'",
            "THEN 'already_paged'",
            "THEN 'page_pi_offline'",
            "THEN 'page_instruments_silent'",
            "ELSE 'within_grace'",
        ].map((v) => verdict.indexOf(v));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // 125's 60-minute cooldown is gone; its decision function is dropped.
        expect(verdict).not.toContain('cooldown');
        expect(body).toContain('DROP FUNCTION IF EXISTS public.vessel_quiet_watch_decision(');
    });

    it('says only what it knows, in two kinds, with the boat’s name, and fits send-push', () => {
        expect(words).toContain("p_boat_name || '’s Pi is offline, or the boat’s internet is down'");
        expect(words).toContain("'The boat’s Pi is offline, or her internet is down'");
        expect(words).toContain("|| ' instruments are silent'");
        expect(words).toContain("'Her Pi is still reporting, but nothing from her GPS or instruments for '");
        expect(words).toContain("'Nothing from her Pi for '");
        expect(words).toContain("p_boat_name || ' is reporting again'");
        expect(words).toContain("'Thalassa is hearing from her Pi again, after '");
        expect(words).toContain("'Her instruments are reporting again, after '");
        // An older Pi's row cannot date the bus: its page hedges, before the plain one.
        expect(words).toContain(
            "WHEN p_kind = 'pi_offline' AND p_bus_unknown THEN COALESCE(p_boat_name || '’s', 'The boat’s') || ' Pi has gone quiet'",
        );
        expect(words).toContain("|| '. Her Pi may be off, her internet down or her instruments silent.'");
        expect(words.indexOf("WHEN p_kind = 'pi_offline' AND p_bus_unknown")).toBeLessThan(
            words.indexOf("WHEN p_kind = 'pi_offline' THEN"),
        );
        // No GPS-clock variant: a stalled GPS clock is never taken for the bus.
        expect(code).not.toMatch(/GPS is silent|gps_only/);
        expect(code).not.toMatch(/sinking|lost power|power lost/i);
        // 60 characters of name and the longest fixed words stay under send-push's 120.
        expect(60 + '’s Pi is offline, or the boat’s internet is down'.length).toBeLessThanOrEqual(120);
    });

    it('pages and clears through the queue only, under the row lock, one row’s failure never the run’s', () => {
        expect(watchdog).toMatch(
            /check_vessel_quiet_watch\(\) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/,
        );
        expect(watchdog).toContain('FOR UPDATE OF q SKIP LOCKED');
        expect(watchdog).toContain(
            'WHERE q.enabled AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = q.owner_id)',
        );
        expect(watchdog).toContain('COALESCE(t.updated_at, t.reported_at) AS last_heard_at');
        // The bus is what her Pi dates it, never reported_at (a GPS clock), never later than last heard.
        expect(watchdog).toContain(
            'CASE WHEN heard.pi_bus_at IS NOT NULL THEN LEAST(heard.last_heard_at, heard.pi_bus_at) END AS bus_at',
        );
        expect(watchdog).toContain('heard.pi_bus_at IS NULL AS bus_unknown');
        expect(watchdog).not.toMatch(/heard\.reported_at|t\.reported_at,/);
        expect(watchdog).toContain("jsonb_typeof(t.extra -> 'bus_at_ms') = 'number'");
        const inserts = watchdog.match(/INSERT INTO [a-z_.]+/g) ?? [];
        expect(inserts).toEqual([
            'INSERT INTO public.push_notification_queue',
            'INSERT INTO public.push_notification_queue',
        ]);
        // The page goes to the recipients and records who they were, in the same branch.
        const page = watchdog.slice(
            watchdog.indexOf("ELSIF verdict IN ('page_pi_offline', 'page_instruments_silent') THEN"),
        );
        expect(page).toContain('recipients := public.vessel_quiet_watch_recipients(watch.owner_id);');
        expect(page).toContain(
            'SET paged_at = now(), paged_last_heard_at = watch.last_heard_at, paged_bus_at = watch.bus_at, paged_kind = kind, paged_recipients = recipients, last_paged_at = now()',
        );
        expect(page).toContain("SELECT paged.recipient, 'boat_quiet', said.title, said.body,");
        expect(page).toContain('FROM unnest(recipients) AS paged(recipient);');
        // The all-clear: only those paged (a 125 page: the owner), then the page is closed.
        const clear = watchdog.slice(
            watchdog.indexOf("IF verdict = 'recovered' THEN"),
            watchdog.indexOf('ELSIF verdict IN'),
        );
        expect(clear).toContain("SELECT paged.recipient, 'boat_quiet_clear', said.title, said.body,");
        expect(clear).toContain(
            'FROM unnest(COALESCE(watch.paged_recipients, ARRAY[watch.owner_id])) AS paged(recipient)',
        );
        expect(clear).toContain(
            'SET paged_at = NULL, paged_last_heard_at = NULL, paged_bus_at = NULL, paged_kind = NULL, paged_recipients = NULL, cleared_at = now()',
        );
        // A page the drain still holds is set aside first: it can never land on the all-clear.
        expect(clear).toContain(
            "UPDATE public.push_notification_queue SET sent_at = now(), processing_at = NULL, last_error = 'superseded by the all-clear' WHERE recipient_user_id = ANY (COALESCE(watch.paged_recipients, ARRAY[watch.owner_id])) AND notification_type = 'boat_quiet' AND sent_at IS NULL AND data ->> 'collapse' = collapse;",
        );
        expect(clear.indexOf('UPDATE public.push_notification_queue')).toBeLessThan(
            clear.indexOf('INSERT INTO public.push_notification_queue'),
        );
        // One lock-screen notification per boat: both carry the same collapse key.
        expect(watchdog).toContain("collapse := left(md5('vessel-quiet-watch:' || watch.owner_id::text), 16);");
        expect(watchdog.match(/'collapse', collapse/g)).toHaveLength(2);
        expect(watchdog).toContain(
            "EXCEPTION WHEN OTHERS THEN failed_state := SQLSTATE; RAISE WARNING 'check_vessel_quiet_watch skipped one watch (SQLSTATE %)', failed_state;",
        );
        expect(watchdog).not.toContain('SQLERRM');
        for (const forbidden of [/net\.http/i, /http_post/i, /invoke_edge_function/i, /functions\/v1/i, /vault\./i]) {
            expect(code).not.toMatch(forbidden);
        }
    });

    it('switched off while a page is open: one closing word to those paged, a held page set aside, never a blocked switch', () => {
        expect(switchedOff).toMatch(
            /RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/,
        );
        // The same per-boat key as the watchdog's page, so it lands on that notification.
        expect(switchedOff).toContain("collapse := left(md5('vessel-quiet-watch:' || OLD.owner_id::text), 16);");
        expect(watchdog).toContain("collapse := left(md5('vessel-quiet-watch:' || watch.owner_id::text), 16);");
        expect(switchedOff).toContain('paged := COALESCE(OLD.paged_recipients, ARRAY[OLD.owner_id]);');
        expect(switchedOff).toContain(
            "UPDATE public.push_notification_queue SET sent_at = now(), processing_at = NULL, last_error = 'superseded: the watch was switched off' WHERE recipient_user_id = ANY (paged) AND notification_type = 'boat_quiet' AND sent_at IS NULL AND data ->> 'collapse' = collapse;",
        );
        expect(switchedOff).toContain("'clear_watch_off', public.vessel_quiet_watch_boat_name(OLD.owner_id), 0, false");
        expect(switchedOff).toContain("SELECT stood.recipient, 'boat_quiet_clear', said.title, said.body,");
        expect(switchedOff).toContain(
            'SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = stood.recipient',
        );
        // A failure is a warning, never an error that would refuse the switch-off.
        expect(switchedOff).toContain(
            "EXCEPTION WHEN OTHERS THEN RAISE WARNING 'vessel_quiet_watch_after_switch_off sent no closing word (SQLSTATE %)', SQLSTATE;",
        );
        expect(switchedOff).toContain('RETURN NULL;');
        expect(body).toContain(
            'CREATE TRIGGER vessel_quiet_watch_after_switch_off AFTER UPDATE OF enabled ON public.vessel_quiet_watch FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled AND OLD.paged_at IS NOT NULL) EXECUTE FUNCTION public.vessel_quiet_watch_after_switch_off();',
        );
        expect(body).toContain(
            'DROP TRIGGER IF EXISTS vessel_quiet_watch_after_switch_off ON public.vessel_quiet_watch;',
        );
        expect(words).toContain("|| ' quiet-boat watch is off'");
        expect(words).toContain(
            "'The watch was switched off, so Thalassa won’t page about her, or say when she reports again, until it’s on again.'",
        );
    });

    it('lets crew read and set only their own pages, signed in, through two calls', () => {
        expect(crewBoats).toMatch(
            /RETURNS TABLE \(owner_id UUID, boat_name TEXT, watch_on BOOLEAN, paging_me BOOLEAN\) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/,
        );
        expect(crewBoats).toContain(
            'WHERE membership.crew_user_id = auth.uid() AND public.vessel_quiet_watch_crew_qualifies(membership.owner_id, auth.uid())',
        );
        expect(crewBoats).toContain('WHERE optout.user_id = auth.uid() AND optout.owner_id = boat.owner_id');
        expect(setPage).toMatch(/RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
        expect(setPage).toContain('me UUID := auth.uid();');
        expect(setPage).toContain(
            'DELETE FROM public.vessel_quiet_watch_optouts WHERE user_id = me AND owner_id = p_owner_id;',
        );
        expect(setPage).toContain('IF NOT public.vessel_quiet_watch_crew_qualifies(p_owner_id, me) THEN');
        expect(setPage).toContain(
            'INSERT INTO public.vessel_quiet_watch_optouts (user_id, owner_id) VALUES (me, p_owner_id)',
        );
        for (const fn of ['vessel_quiet_watch_crew_boats()', 'set_vessel_quiet_watch_crew_page(UUID, BOOLEAN)']) {
            expect(body).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
            expect(body).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
        }
        // Every helper is out of reach of the app.
        for (const fn of [
            'vessel_quiet_watch_crew_qualifies(UUID, UUID)',
            'vessel_quiet_watch_recipients(UUID)',
            'vessel_quiet_watch_boat_name(UUID)',
            'vessel_quiet_watch_duration(INTEGER)',
            'vessel_quiet_watch_message(TEXT, TEXT, INTEGER, BOOLEAN)',
            'check_vessel_quiet_watch()',
            'vessel_quiet_watch_after_switch_off()',
        ]) {
            expect(body).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
            expect(body).not.toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
        }
        expect(body).not.toMatch(/TO anon\b/);
    });

    it('send-push maps both types onto one Time Sensitive page and a quiet replacement', () => {
        const config = readFileSync('supabase/functions/send-push/config.ts', 'utf8');
        expect(config).toContain("case 'boat_quiet':");
        expect(config).toContain("case 'boat_quiet_clear':");
        expect(config).toContain("return 'thalassa-boat';");
        expect(config).toMatch(/boat-quiet-\$\{data\.collapse\}/);
        // Never a Critical type: a quiet boat is news hours later, not for seconds only.
        const critical = config.slice(
            config.indexOf('function isCriticalType'),
            config.indexOf('function getThreadId'),
        );
        expect(critical).not.toContain('boat_quiet');
    });
});
