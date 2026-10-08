/**
 * The 'boat went quiet' watchdog (2026-10-09, plan 125-11 item 3): a
 * per-skipper opt-in, default off, that queues ONE push to the owner through
 * the existing push_notification_queue after 15 minutes of telemetry silence
 * outside a declared weekly quiet window, then nothing until recovery.
 *
 * These pin the safety shape. The decision itself was replayed read-only
 * against production over synthetic rows (fresh, stale, null, windows across
 * midnight in three zones, opted out, paged, recovered, cooldown). The page
 * INSERT and the selection over vessel_telemetry / account_deletion_jobs were
 * planned against production with EXPLAIN (GENERIC_PLAN), which resolves every
 * name and type without executing. The statements on the new table itself
 * cannot be planned before it exists, so the column pins below stand in.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261009150000_vessel_quiet_watch.sql', 'utf8');
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

const table = between('CREATE TABLE IF NOT EXISTS public.vessel_quiet_watch (', '); COMMENT ON TABLE');
const beforeWrite = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_before_write()');
const decision = between('CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_decision(');
const watchdog = between('CREATE OR REPLACE FUNCTION public.check_vessel_quiet_watch()');

describe('vessel_quiet_watch migration', () => {
    it('is an opt-in per skipper, OFF by default, removed with the account', () => {
        expect(table).toContain('owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(table).toContain('enabled BOOLEAN NOT NULL DEFAULT false');
        expect(table).toContain(
            'quiet_after_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (quiet_after_minutes BETWEEN 15 AND 720)',
        );
        expect(table).toContain('window_dow SMALLINT CHECK (window_dow BETWEEN 0 AND 6)');
        // A window is all four fields or none, never longer than 12 hours, never empty.
        expect(table).toContain(
            '(window_dow IS NULL AND window_start IS NULL AND window_end IS NULL AND window_tz IS NULL) OR (window_dow IS NOT NULL AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_tz IS NOT NULL)',
        );
        expect(table).toContain("END <= interval '12 hours'");
        expect(table).toContain('window_start <> window_end');
        // A failing watch leaves a mark a read-only query can see.
        expect(table).toContain('last_error_at TIMESTAMPTZ,');
        expect(table).toContain(
            "last_error_sqlstate TEXT CHECK (last_error_sqlstate IS NULL OR last_error_sqlstate ~ '^[0-9A-Z]{5}$'),",
        );
    });

    it('names only columns its own table defines, so the unplannable statements resolve', () => {
        // PL/pgSQL resolves names only when a statement first runs, and the
        // watchdog's statements on vessel_quiet_watch cannot be planned against
        // production before the table exists. Every q.<column> the selection
        // reads and every column an UPDATE sets must be in the CREATE TABLE.
        const defined = new Set(
            [...table.matchAll(/(?:\( |, )([a-z_]+) (?:UUID|BOOLEAN|SMALLINT|TIME|TEXT|TIMESTAMPTZ)\b/g)].map(
                (m) => m[1],
            ),
        );
        expect(defined).toEqual(
            new Set([
                'owner_id',
                'enabled',
                'quiet_after_minutes',
                'window_dow',
                'window_start',
                'window_end',
                'window_tz',
                'armed_at',
                'paged_at',
                'paged_last_heard_at',
                'last_paged_at',
                'last_error_at',
                'last_error_sqlstate',
                'created_at',
                'updated_at',
            ]),
        );
        const read = [...watchdog.matchAll(/\bq\.([a-z_]+)/g)].map((m) => m[1]);
        expect(read.length).toBeGreaterThan(10);
        for (const column of read) expect(defined, `q.${column}`).toContain(column);
        const updates = watchdog.match(/UPDATE public\.vessel_quiet_watch SET [^;]*?WHERE/g) ?? [];
        expect(updates).toHaveLength(3);
        for (const update of updates) {
            const sets = update.replace(/^UPDATE public\.vessel_quiet_watch SET /, '').replace(/ WHERE$/, '');
            for (const assignment of sets.split(', ')) {
                const column = assignment.split(' = ')[0];
                expect(defined, `SET ${column}`).toContain(column);
            }
        }
        const triggerColumns = [...beforeWrite.matchAll(/NEW\.([a-z_]+)/g)].map((m) => m[1]);
        for (const column of triggerColumns) expect(defined, `NEW.${column}`).toContain(column);
    });

    it('switches nothing on and carries no ids', () => {
        expect(body).not.toMatch(/INSERT INTO public\.vessel_quiet_watch/i);
        expect(body).not.toMatch(/UPDATE public\.vessel_quiet_watch SET enabled/i);
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/\b\d{9}\b/); // no MMSI
        expect(body).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it('lets only the owner read or change their own watch, and never the paged state', () => {
        expect(body).toContain('ALTER TABLE public.vessel_quiet_watch ENABLE ROW LEVEL SECURITY;');
        expect(body).toContain('REVOKE ALL ON TABLE public.vessel_quiet_watch FROM PUBLIC, anon, authenticated;');
        expect(body).toContain('GRANT SELECT, DELETE ON TABLE public.vessel_quiet_watch TO authenticated;');
        expect(body).toContain(
            'GRANT INSERT (owner_id, enabled, quiet_after_minutes, window_dow, window_start, window_end, window_tz) ON TABLE public.vessel_quiet_watch TO authenticated;',
        );
        expect(body).toContain(
            'GRANT UPDATE (enabled, quiet_after_minutes, window_dow, window_start, window_end, window_tz) ON TABLE public.vessel_quiet_watch TO authenticated;',
        );
        const grants = body.match(/GRANT [^;]*ON TABLE public\.vessel_quiet_watch[^;]*;/g) ?? [];
        expect(grants).toHaveLength(3);
        for (const grant of grants) {
            expect(grant).not.toMatch(
                /armed_at|paged_at|paged_last_heard_at|last_paged_at|last_error|updated_at|created_at/,
            );
            expect(grant).not.toMatch(/TO (anon|PUBLIC)/i);
        }

        const policies = body.match(/CREATE POLICY [^;]*ON public\.vessel_quiet_watch[^;]*;/g) ?? [];
        expect(policies).toHaveLength(4);
        expect(policies.join(' ')).toContain('FOR SELECT TO authenticated USING (owner_id = auth.uid())');
        expect(policies.join(' ')).toContain('FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())');
        expect(policies.join(' ')).toContain(
            'FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())',
        );
        expect(policies.join(' ')).toContain('FOR DELETE TO authenticated USING (owner_id = auth.uid())');
        for (const policy of policies) {
            // Owner only: crew and boat members never see or steer it.
            expect(policy).not.toMatch(/vessel_crew|boat_members|TO anon|TO PUBLIC/i);
        }
    });

    it('arms on switch-on, clears on switch-off, keeps the owner fixed and only takes real IANA zones', () => {
        expect(beforeWrite).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS \$\$/);
        expect(beforeWrite).not.toContain('SECURITY DEFINER');
        expect(beforeWrite).toContain("IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN");
        expect(beforeWrite).toContain(
            'NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS zone WHERE zone.name = NEW.window_tz)',
        );
        expect(beforeWrite).toContain(
            "IF NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN NEW.armed_at := now(); NEW.paged_at := NULL; NEW.paged_last_heard_at := NULL; NEW.last_error_at := NULL; NEW.last_error_sqlstate := NULL;",
        );
        expect(beforeWrite).toContain(
            'ELSIF NOT NEW.enabled THEN NEW.armed_at := NULL; NEW.paged_at := NULL; NEW.paged_last_heard_at := NULL; NEW.last_error_at := NULL; NEW.last_error_sqlstate := NULL;',
        );
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.vessel_quiet_watch_before_write() FROM PUBLIC, anon, authenticated;',
        );
        expect(body).toContain(
            "BEFORE INSERT OR UPDATE ON public.vessel_quiet_watch FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');",
        );
    });

    it('decides in the vessel’s own zone, never a hard-coded one, as one pure expression', () => {
        expect(decision).toMatch(/RETURNS TEXT LANGUAGE sql STABLE SET search_path = pg_catalog AS \$\$ WITH clock AS/);
        expect(decision).not.toContain('SECURITY DEFINER');
        expect(decision).toContain('SELECT p_now AT TIME ZONE p_window_tz AS local_now');
        expect(decision).toContain('AT TIME ZONE p_window_tz FROM occurrence) AS last_window_closed');
        // Every zone conversion uses the vessel's own zone; the SQL names no
        // Australian zone and no fixed offset (a help message may cite an example).
        const conversions = [...body.matchAll(/AT TIME ZONE ([^\s)]+)/g)].map((m) => m[1]);
        expect(conversions.length).toBeGreaterThanOrEqual(2);
        expect(new Set(conversions)).toEqual(new Set(['p_window_tz']));
        expect(code).not.toMatch(/Australia\/|Brisbane|AEST|AEDT|UTC\+|'\+10'|interval '10 hours'/);
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.vessel_quiet_watch_decision( TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, TIME, TIME, TEXT ) FROM PUBLIC, anon, authenticated;',
        );

        // Verdict order is the safety: a recovery clears a page even inside
        // the window, an open page is never repeated, and the window and the
        // grace both come before any page.
        const order = [
            "THEN 'off'",
            "THEN 'never_heard'",
            "THEN 'recovered'",
            "THEN 'already_paged'",
            "THEN 'in_window'",
            "THEN 'within_grace'",
            "THEN 'cooldown'",
            "ELSE 'page'",
        ].map((verdict) => decision.indexOf(verdict));
        expect(order.every((at) => at > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(decision).toContain(
            'p_now - GREATEST(p_last_heard_at, p_armed_at, verdict_input.last_window_closed) < make_interval(mins => COALESCE(p_quiet_after_minutes, 15))',
        );
        expect(decision).toContain("WHEN p_last_paged_at > p_now - interval '60 minutes' THEN 'cooldown'");
        expect(decision).toContain("WHEN verdict_input.in_window THEN 'in_window'");
        expect(decision).toContain('COALESCE((SELECT local_now < closes_local FROM occurrence), false) AS in_window');
        // The latest opening at or before local now; a window may cross midnight.
        expect(decision).toContain(
            '(local_now::date - ((EXTRACT(DOW FROM local_now)::int - p_window_dow + 7) % 7)) + p_window_start AS opens_local',
        );
        expect(decision).toContain(
            "CASE WHEN opens_local > local_now THEN opens_local - interval '7 days' ELSE opens_local END AS opened_local",
        );
        expect(decision).toContain("ELSE p_window_end - p_window_start + interval '24 hours' END AS closes_local");

        // The replay lifts this body verbatim: it must stay one statement.
        const lifted = sql.match(/FUNCTION public\.vessel_quiet_watch_decision\([\s\S]*?\nAS \$\$([\s\S]*?)\$\$;/);
        expect(lifted).not.toBeNull();
        expect(lifted![1]).not.toContain(';');
    });

    it('pages the owner only, once per outage, through the existing queue', () => {
        expect(watchdog).toMatch(
            /check_vessel_quiet_watch\(\) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/,
        );
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.check_vessel_quiet_watch() FROM PUBLIC, anon, authenticated;',
        );
        expect(body).not.toMatch(/GRANT [^;]*ON FUNCTION public\.check_vessel_quiet_watch/);

        // Selection: switched-on watches, last heard by the server's clock,
        // tombstoned accounts skipped, rows locked so overlapping runs cannot double-page.
        expect(watchdog).toContain('COALESCE(t.updated_at, t.reported_at) AS last_heard_at');
        expect(watchdog).toContain('LEFT JOIN public.vessel_telemetry AS t ON t.owner_id = q.owner_id');
        expect(watchdog).toContain('WHERE q.enabled AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs');
        expect(watchdog).toContain('FOR UPDATE OF q SKIP LOCKED');

        // One INSERT, into the queue, addressed to the watch's own owner.
        const inserts = watchdog.match(/INSERT INTO [a-z_.]+/g) ?? [];
        expect(inserts).toEqual(['INSERT INTO public.push_notification_queue']);
        expect(watchdog).toContain(
            "INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data) VALUES ( watch.owner_id, 'boat_quiet',",
        );
        // The page and its paged state are written together.
        const page = watchdog.slice(watchdog.indexOf("ELSIF verdict = 'page' THEN"), watchdog.indexOf('END IF;'));
        expect(page).toContain(
            'SET paged_at = now(), paged_last_heard_at = watch.last_heard_at, last_paged_at = now() WHERE owner_id = watch.owner_id;',
        );
        expect(watchdog).toContain(
            "IF verdict = 'recovered' THEN UPDATE public.vessel_quiet_watch SET paged_at = NULL, paged_last_heard_at = NULL WHERE owner_id = watch.owner_id;",
        );
        // One bad row is skipped, never the whole run, and never silently:
        // pg_cron reports 'succeeded' either way, so the row carries the mark.
        expect(watchdog).toContain(
            "EXCEPTION WHEN OTHERS THEN failed_state := SQLSTATE; RAISE WARNING 'check_vessel_quiet_watch skipped one watch (SQLSTATE %)', failed_state; BEGIN UPDATE public.vessel_quiet_watch SET last_error_at = now(), last_error_sqlstate = failed_state WHERE owner_id = watch.owner_id; EXCEPTION WHEN OTHERS THEN RAISE WARNING",
        );
        // The state code only: a message can carry values, so none is stored or logged.
        expect(watchdog).not.toContain('SQLERRM');
        expect(watchdog).not.toContain('PG_EXCEPTION_DETAIL');
        // No position, name or other person in the payload.
        expect(watchdog).not.toMatch(/\blat\b|\blon\b|boat_name|crew/);
    });

    it('makes no network call of its own', () => {
        for (const forbidden of [
            /net\.http/i,
            /http_post/i,
            /extensions\.http/i,
            /invoke_edge_function/i,
            /functions\/v1/i,
            /vault\./i,
            /send-push/i,
        ]) {
            expect(code).not.toMatch(forbidden);
        }
    });

    it('schedules the job idempotently, every minute, only where pg_cron exists, and never resumes a paused one', () => {
        const job = between('DO $schedule$', '$schedule$;');
        expect(job).toContain("job_name CONSTANT TEXT := 'vessel-quiet-watch';");
        expect(job).toContain("want_schedule CONSTANT TEXT := '* * * * *';");
        expect(job).toContain("want_command CONSTANT TEXT := 'SELECT public.check_vessel_quiet_watch()';");
        expect(job).toContain(
            "IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN RETURN; END IF;",
        );
        expect(job).toContain("regexp_replace(btrim(command), '\\s+', ' ', 'g') = want_command");

        // Order: no pg_cron -> nothing; paused -> NOTICE and leave it; exact
        // and active -> leave it (job id and history kept); else unschedule
        // every row of this name, then schedule once.
        const steps = [
            "extname = 'pg_cron') THEN RETURN;",
            'IF paused > 0 THEN RAISE NOTICE',
            'IF total = 1 AND exact = 1 THEN RETURN; END IF;',
            'FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP PERFORM cron.unschedule(existing.jobid); END LOOP;',
            'PERFORM cron.schedule(job_name, want_schedule, want_command);',
        ].map((step) => job.indexOf(step));
        expect(steps.every((at) => at > 0)).toBe(true);
        expect([...steps].sort((a, b) => a - b)).toEqual(steps);
        const pausedGuard = job.slice(
            job.indexOf('IF paused > 0 THEN'),
            job.indexOf('END IF;', job.indexOf('IF paused > 0')),
        );
        expect(pausedGuard).toContain('RETURN;');

        expect(body.match(/cron\.schedule\(/g)).toHaveLength(1);
        expect(body.match(/cron\.unschedule\(/g)).toHaveLength(1);
        expect(code).not.toMatch(/cron\.alter_job/);
        // It touches no other job: every cron.job lookup is scoped to this name.
        for (const m of job.matchAll(/FROM cron\.job\b([^;]*)/g)) {
            expect(m[1]).toMatch(/WHERE jobname = job_name/);
        }
        expect(job).not.toMatch(/shore-watch-health|retry-pending/);
    });

    it('stays an ordinary alert in send-push: boat_quiet is not a critical type', () => {
        const sendPush = readFileSync('supabase/functions/send-push/index.ts', 'utf8');
        const critical = sendPush.slice(
            sendPush.indexOf('function isCriticalType'),
            sendPush.indexOf('function getThreadId'),
        );
        expect(critical).not.toContain('boat_quiet');
        // send-push refuses titles over 120 and bodies over 500 characters.
        const title = watchdog.match(/'boat_quiet', '([^']+)'/);
        expect(title).not.toBeNull();
        expect(title![1].length).toBeLessThanOrEqual(120);
        // "No updates", not "lost power": telemetry also stops while the Pi is
        // up (Signal K down, satellite mode, pairing lost), so say what is known.
        const bodyText = watchdog.match(/'Thalassa has had no updates[^;]*?again\.'/);
        expect(watchdog).not.toMatch(/lost power/);
        expect(bodyText).not.toBeNull();
        expect(bodyText![0].length + 20).toBeLessThanOrEqual(500);
    });
});
