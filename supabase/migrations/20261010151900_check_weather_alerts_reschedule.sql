-- Background weather alerts run again (2026-10-10, build 126, package
-- 126-19, live drift finding B-05 = C2).
--
-- Approved by Shane, 2026-10-10 ~06:05, verbatim: "1 - yes, 2 - yes"
-- (1 = turn the background weather alerts back on, this file;
--  2 = send pushes instantly, 20261010151400).
--
-- Not pushed with this commit: it goes in the 126 release push, last of the
-- 126-19 repairs.
--
-- Why
-- ───
-- The 30-minute pg_cron job 'check-weather-alerts' checks each sailor's wind,
-- gust and wave thresholds while the app is closed. Settings → Alerts
-- (AlertsTab) promises exactly that. The read-only drift scan of 2026-10-10
-- found the job missing from live's cron.job: it had run 7,032 times, the last
-- at 2026-08-12 21:00 UTC, the moment 20260813060000_edge_cron_vault_credentials.sql
-- moved it onto invoke_edge_function. Its two siblings from that same loop are
-- live and on the helper, no migration unschedules it, and nothing records
-- removing it on purpose. The edge function is deployed. So anyone who armed
-- an alert and closed the app has had nothing for nearly two months.
--
-- What
-- ────
-- The job exactly as 20260813060000 declared it: every 30 minutes,
--     SELECT public.invoke_edge_function('check-weather-alerts', 150000)
-- (the vault credential path, 150 s ceiling). By state of cron.job:
-- * already exactly this job and active: left untouched (job id and history kept);
-- * missing (live today): scheduled;
-- * present but PAUSED: left paused, with a NOTICE; somebody paused it on
--   purpose, and a migration does not resume it behind their back;
-- * present and active with another schedule or command: every job of that
--   name is unscheduled, then it is scheduled afresh.
-- No other job is read or changed. The pattern is
-- 20261009075000_shore_watch_health_cron.sql's.
--
-- Undo
-- ────
--     SELECT cron.unschedule('check-weather-alerts');
-- To pause it instead, keeping the job:
--     SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'check-weather-alerts'), active := false);
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op, then confirms cron.job is back
-- to its prior state. lock_timeout is set for the session and reset at the end.

SET lock_timeout = '5s';

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'check-weather-alerts';
    want_schedule CONSTANT TEXT := '*/30 * * * *';
    want_command CONSTANT TEXT := 'SELECT public.invoke_edge_function(''check-weather-alerts'', 150000)';
    total INTEGER;
    paused INTEGER;
    exact INTEGER;
    existing RECORD;
BEGIN
    IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'check_weather_alerts_reschedule: invoke_edge_function(text, integer, jsonb) is missing';
    END IF;

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

DO $check$
DECLARE
    total INTEGER;
    declared INTEGER;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active
               OR (schedule = '*/30 * * * *'
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g') = 'SELECT public.invoke_edge_function(''check-weather-alerts'', 150000)'))
      INTO total, declared
      FROM cron.job
     WHERE jobname = 'check-weather-alerts';
    IF total <> 1 OR declared <> 1 THEN
        RAISE EXCEPTION 'check_weather_alerts_reschedule: expected one check-weather-alerts job, every 30 min on invoke_edge_function; found % (% as declared)', total, declared;
    END IF;
END;
$check$;

RESET lock_timeout;
