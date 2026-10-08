-- Shore Watch: the 'shore-watch-health' minute job, recorded in source control.
--
-- What this does
-- ──────────────
-- 20260923170000 left the Pi anchor-watch watchdog's schedule as a commented
-- "DEPLOYMENT STEP". It was then switched on by hand (docs/SHORE_WATCH_RELIABILITY.md,
-- 2026-09-23) and widened on 2026-09-24 to queue repeat reminders as well, so
-- the live job runs TWO statements, not the one in that comment:
--
--     SELECT public.check_pi_anchor_watch_health(); SELECT public.queue_anchor_alarm_reminders();
--
-- Nothing in the repo created that job, so any fresh database (local, a branch,
-- a restored project) would have no server watchdog at all, silently: a Pi
-- that died at anchor would alarm nobody ashore. This file makes the job part
-- of the schema, with the live command exactly.
--
-- Scheduling the 2026-09-23 comment verbatim would have DROPPED the reminder
-- statement and quietly ended repeat alarms. Hence the exact live command.
--
-- Read-only checks, 2026-10-09 (counts only): migrations 20260923170000 and
-- 20260924090000 are applied; the live function bodies match those files;
-- the job has run every minute since 2026-09-23, 1440 of 1440 runs succeeded
-- in the last 24 h, none has ever failed, mean run time about 60 ms.
-- retry-pending-anchor-alarm is active, every minute. send-anchor-alarm and
-- anchor-relay are deployed.
--
-- Behaviour, by state of cron.job
-- ───────────────────────────────
-- * Already exactly this job and active (production today): left untouched,
--   keeping its job id and run history. Against production this file is a
--   no-op apart from its row in the migration history.
-- * Missing: created, every minute.
-- * Present but PAUSED: left paused, with a NOTICE. Somebody paused it on
--   purpose; a migration does not resume it behind their back.
-- * Present and active with another schedule or command: every row of that
--   name is unscheduled, then the job is scheduled afresh.
-- No other job is read or changed: not retry-pending-anchor-alarm, not any
-- paused job.
--
-- Review of check_pi_anchor_watch_health() (20260923170000), as it runs
-- ─────────────────────────────────────────────────────────────────────
-- Reads: pi_anchor_sessions joined to anchor_watch_sessions (hard expiry) and
--   pi_diary_relays (enabled). Only bindings whose session AND lease are both
--   unexpired, on an enabled relay, are looked at. FOR UPDATE SKIP LOCKED: a
--   binding mid-heartbeat is skipped this minute, never waited on.
-- Writes: contact_alarm_at / expiry_alarm_at on the binding (one-shot flags).
-- Queues: one anchor_alarm_events row per alarm. Its AFTER INSERT trigger
--   (notify_anchor_alarm) posts to send-anchor-alarm through pg_net; nothing
--   else leaves the database. The function itself makes no network call.
-- Pages, per boat:
--   * contact_lost: once per outage, after 60 s with no heartbeat (the Pi
--     reports every 10 s), so 60-120 s after the last one. A heartbeat clears
--     the flag, so every outage longer than 60 s pages once. A boat router
--     that reboots on a schedule will page each time it does during a Pi watch.
--   * session_expiring: once per binding, 15 min before the 24 h hard expiry.
--     A re-authorise from the phone (hourly, and whenever the app comes to the
--     foreground) clears both flags, so this can repeat inside those 15 min,
--     and a dead Pi gets a fresh contact_lost row per re-authorise (same
--     incident, so a phone that tapped Silence stays silenced).
--   After the first page, retry-pending-anchor-alarm retries undelivered
--   events for one hour, and queue_anchor_alarm_reminders() repeats
--   contact_lost to phones that opted in, about every 1-2 min, until that phone
--   taps Silence, contact returns, or the lease lapses (at most 6 h after the
--   last heartbeat or re-authorise). send-anchor-alarm rechecks the live state
--   before each send.
-- Empty table: the loop runs zero times and writes nothing.
-- NULL / stale fields: last_heartbeat_at NULL falls back to authorised_at
--   (NOT NULL), so a Pi that never reports pages 60 s after authorisation.
-- Ended watches: a Pi 'stop' deletes the binding; an expired session, a lapsed
--   lease or a disabled relay drops out of the selection. It can still page
--   about a watch the skipper ended in two narrow cases: (a) the Pi took the
--   local stop but its one cloud 'stop' call failed, then went quiet; (b) the
--   phone authorised the relay but the Pi never accepted the watch (the phone
--   kept it). Both page contact_lost within 2 min and stop when the lease
--   lapses. Neither is changed here; they are listed for follow-up.
-- Failure coupling: the job's two statements run as one command, so an error
--   in the health check also skips that minute's reminders. A silent binding
--   whose owner is tombstoned for deletion would make the flag UPDATE raise
--   (the write fence fails closed since 20261005160000) on every run until its
--   lease lapses, stopping alarms for every boat meanwhile. Read-only count
--   today: zero such bindings. Listed for follow-up.
-- Cost: one join over a handful of rows a minute, every join on a primary or
--   unique key; about 60 ms a run including the reminder query.
--
-- Undo
-- ────
-- On production nothing live changes, so there is nothing to undo. To switch
-- the watchdog off (this also stops repeat reminders, which share the job):
--     SELECT cron.unschedule('shore-watch-health');
-- To pause it instead, keeping the job:
--     SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'shore-watch-health'), active := false);

SET lock_timeout = '5s';

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'shore-watch-health';
    want_schedule CONSTANT TEXT := '* * * * *';
    want_command CONSTANT TEXT :=
        'SELECT public.check_pi_anchor_watch_health(); SELECT public.queue_anchor_alarm_reminders();';
    total INTEGER;
    paused INTEGER;
    exact INTEGER;
    existing RECORD;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active),
           count(*) FILTER (WHERE active
               AND schedule = want_schedule
               AND regexp_replace(btrim(command), '\s+', ' ', 'g') = want_command)
      INTO total, paused, exact
      FROM cron.job
     WHERE jobname = job_name;

    IF paused > 0 THEN
        RAISE NOTICE '% is paused; left paused. Resuming it is a deliberate step, not a migration.', job_name;
        RETURN;
    END IF;

    IF total = 1 AND exact = 1 THEN
        RETURN;
    END IF;

    FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP
        PERFORM cron.unschedule(existing.jobid);
    END LOOP;

    PERFORM cron.schedule(job_name, want_schedule, want_command);
END;
$schedule$;

RESET lock_timeout;
