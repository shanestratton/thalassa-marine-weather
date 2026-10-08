import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Pi anchor-watch watchdog's minute job, as a migration.
 *
 * It ran in production from 2026-09-23, created by hand, so a fresh database
 * had no server watchdog at all. The 2026-09-23 migration's comment named only
 * the health check; the live job also queues repeat reminders (2026-09-24).
 * These pins keep the migration scheduling the LIVE command, idempotently, and
 * touching no other job.
 */
const FILE = '20261009075000_shore_watch_health_cron.sql';
const sql = readFileSync(`supabase/migrations/${FILE}`, 'utf8');
const executable = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const header = sql.slice(0, sql.indexOf('SET lock_timeout'));
const LIVE_COMMAND = 'SELECT public.check_pi_anchor_watch_health(); SELECT public.queue_anchor_alarm_reminders();';

describe('shore-watch-health cron migration', () => {
    it('sorts after every migration that was already applied when it was written', () => {
        const names = readdirSync('supabase/migrations').filter((n) => n.endsWith('.sql'));
        expect(names).toContain(FILE);
        expect(FILE > '20261009070000_enc_cells_shared_read_noaa_only.sql').toBe(true);
        expect(names.filter((n) => n.startsWith('20261009075000_'))).toEqual([FILE]);
    });

    it('schedules the named job every minute with the exact live two-statement command', () => {
        expect(executable).toContain("job_name CONSTANT TEXT := 'shore-watch-health';");
        expect(executable).toContain("want_schedule CONSTANT TEXT := '* * * * *';");
        expect(executable).toContain(`'${LIVE_COMMAND}'`);
        expect(executable).toContain('PERFORM cron.schedule(job_name, want_schedule, want_command);');
        // Health first, then reminders — the order the live job runs them in.
        expect(LIVE_COMMAND.indexOf('check_pi_anchor_watch_health')).toBeLessThan(
            LIVE_COMMAND.indexOf('queue_anchor_alarm_reminders'),
        );
    });

    it('keeps the reminder statement the 2026-09-24 rollout added to the live job', () => {
        // Scheduling the 2026-09-23 comment verbatim would silently end repeat alarms.
        const doc = readFileSync('docs/SHORE_WATCH_RELIABILITY.md', 'utf8');
        expect(doc).toContain(
            'SELECT public.check_pi_anchor_watch_health();\nSELECT public.queue_anchor_alarm_reminders();',
        );
        expect(executable).toContain('queue_anchor_alarm_reminders');
    });

    it('calls only functions an applied migration defines, and redefines none', () => {
        const reliability = readFileSync('supabase/migrations/20260923170000_shore_watch_reliability.sql', 'utf8');
        const reminders = readFileSync('supabase/migrations/20260924090000_shore_watch_alarm_reminders.sql', 'utf8');
        expect(reliability).toContain('CREATE OR REPLACE FUNCTION public.check_pi_anchor_watch_health()');
        expect(reminders).toContain('CREATE OR REPLACE FUNCTION public.queue_anchor_alarm_reminders()');
        expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
        expect(executable).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    });

    it('is idempotent: an exact, active job is left alone; drift is unscheduled before rescheduling', () => {
        const body = executable.slice(executable.indexOf('DO $schedule$'), executable.indexOf('$schedule$;'));
        expect(body).toContain('IF total = 1 AND exact = 1 THEN\n        RETURN;');
        expect(body).toContain("regexp_replace(btrim(command), '\\s+', ' ', 'g') = want_command");
        const noOp = body.indexOf('IF total = 1 AND exact = 1');
        const unscheduleLoop = body.indexOf('FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP');
        const schedule = body.indexOf('PERFORM cron.schedule(');
        expect(noOp).toBeGreaterThan(-1);
        expect(unscheduleLoop).toBeGreaterThan(noOp);
        expect(body).toContain('PERFORM cron.unschedule(existing.jobid);');
        expect(schedule).toBeGreaterThan(unscheduleLoop);
        expect((executable.match(/cron\.schedule\(/g) ?? []).length).toBe(1);
        expect((executable.match(/cron\.unschedule\(/g) ?? []).length).toBe(1);
    });

    it('never resumes a paused job, and never touches any other job', () => {
        const body = executable.slice(executable.indexOf('DO $schedule$'), executable.indexOf('$schedule$;'));
        const pausedGuard = body.indexOf('IF paused > 0 THEN');
        expect(pausedGuard).toBeGreaterThan(-1);
        expect(pausedGuard).toBeLessThan(body.indexOf('cron.unschedule'));
        expect(body.slice(pausedGuard, body.indexOf('END IF;', pausedGuard))).toContain('RETURN;');
        expect(executable).not.toMatch(/cron\.alter_job/);
        expect(executable).not.toContain('retry-pending-anchor-alarm');
        expect(executable).not.toMatch(/retry_pending_anchor_alarms/);
        // Every cron.job lookup is scoped to this one job name.
        for (const m of executable.matchAll(/FROM cron\.job\b([^;]*)/g)) {
            expect(m[1]).toMatch(/WHERE jobname = job_name/);
        }
    });

    it('carries the review and the undo in its header, with no ids or secrets anywhere', () => {
        expect(header).toContain('check_pi_anchor_watch_health()');
        expect(header).toContain('Ended watches:');
        expect(header).toContain('Empty table:');
        expect(header).toContain('Cost:');
        expect(header).toContain("SELECT cron.unschedule('shore-watch-health');");
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role_key'|Bearer /);
        expect(sql).not.toMatch(/\.supabase\.co/);
    });
});
