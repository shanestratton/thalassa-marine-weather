-- Cyclone warnings near the boat: the watcher's state, its status call and its
-- cron job (2026-10-14, build 129, package 129-09).
--
-- HELD. Written with 129, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and this one waits until Shane has deployed
-- send-push (the two cyclone types), cyclone-feed, fetch-gfs-tracker and
-- cyclone-watch (129-09b: cyclone-watch reads the warning centres through the
-- same shared feed as cyclone-feed; no Esri, no knackwx).
-- Release it by moving it into supabase/migrations under a stamp newer than
-- the newest applied migration and, in the same commit, rewriting
-- tests/CycloneWatchMigration.test.ts to read the released file (the vessel
-- vault limits were released that way on 2026-10-13, b85cd258d), then push.
-- Until it runs, nothing answers
-- cyclone_watch_status(), so the app keeps "Cyclone warnings near the boat"
-- hidden: no switch is offered that nothing honours.
--
-- What
-- ────
-- * cyclone_watch_alerts: one row per boat and storm the watcher has measured
--   inside 600 NM (or the track rule), holding only levels, times, advisory
--   ids, the storm's name and its warning centre's id. No position: the push
--   carries distance and bearing, and nothing stored here does. Service role
--   only (RLS on, no policy, privileges revoked). The account-deletion write
--   fence, as every user-keyed table has it, and ON DELETE CASCADE.
-- * cyclone_watch_status: one row, written at the end of every run: when it
--   ran, since when the storm lists have been unavailable (null when one
--   answered), each source ('ok', 'none', or since when it has been
--   unavailable), how many storms and pushes. Service role only.
-- * cyclone_watch_status(): what the app reads to decide whether to show the
--   switch: ran_at and unavailable_since, nothing else. Signed-in callers
--   only; SECURITY DEFINER with a pinned search_path.
-- * The 'cyclone-watch' cron job, every 30 min at :10 and :40 (clear of
--   check-weather-alerts at :00 and :30), on the vault credential path:
--       SELECT public.invoke_edge_function('cyclone-watch', 150000)
--   By state of cron.job (the 20261009075000 shore-watch pattern):
--   * already exactly this job and active: left untouched;
--   * missing: scheduled;
--   * present but PAUSED: left paused, with a NOTICE;
--   * present and active with another schedule or command: every job of that
--     name is unscheduled, then it is scheduled afresh.
--   No other job is read or changed.
--
-- Undo
-- ────
--     SELECT cron.unschedule('cyclone-watch');
--     DROP FUNCTION IF EXISTS public.cyclone_watch_status();
--     DROP TABLE IF EXISTS public.cyclone_watch_status, public.cyclone_watch_alerts;
-- (the app then hides the switch again, as the status call no longer answers).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op, then confirms cron.job is back
-- to its prior state. lock_timeout is set for the session and reset at the end.

SET lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'cyclone_watch: invoke_edge_function(text, integer, jsonb) is missing';
    END IF;
    IF to_regprocedure('public.block_tombstoned_account_write()') IS NULL THEN
        RAISE EXCEPTION 'cyclone_watch: block_tombstoned_account_write() (the account-deletion fence) is missing';
    END IF;
END;
$precheck$;

CREATE TABLE IF NOT EXISTS public.cyclone_watch_alerts (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    storm_key TEXT NOT NULL CHECK (storm_key ~ '^[A-Z0-9]{2,12}$'),
    state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 2048),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, storm_key)
);

ALTER TABLE public.cyclone_watch_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cyclone_watch_alerts FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.cyclone_watch_alerts;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.cyclone_watch_alerts
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

CREATE TABLE IF NOT EXISTS public.cyclone_watch_status (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    ran_at TIMESTAMPTZ NOT NULL,
    unavailable_since TIMESTAMPTZ,
    sources JSONB NOT NULL DEFAULT '{}'::jsonb,
    storms INTEGER,
    pushes INTEGER
);

ALTER TABLE public.cyclone_watch_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cyclone_watch_status FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cyclone_watch_status()
RETURNS TABLE (ran_at timestamptz, unavailable_since timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT s.ran_at, s.unavailable_since FROM public.cyclone_watch_status AS s WHERE s.id = 1;
$$;

REVOKE ALL ON FUNCTION public.cyclone_watch_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cyclone_watch_status() TO authenticated;

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'cyclone-watch';
    want_schedule CONSTANT TEXT := '10,40 * * * *';
    want_command CONSTANT TEXT := 'SELECT public.invoke_edge_function(''cyclone-watch'', 150000)';
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

DO $check$
DECLARE
    total INTEGER;
    declared INTEGER;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active
               OR (schedule = '10,40 * * * *'
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g') = 'SELECT public.invoke_edge_function(''cyclone-watch'', 150000)'))
      INTO total, declared
      FROM cron.job
     WHERE jobname = 'cyclone-watch';
    IF total <> 1 OR declared <> 1 THEN
        RAISE EXCEPTION 'cyclone_watch: expected one cyclone-watch job, at :10 and :40 on invoke_edge_function; found % (% as declared)', total, declared;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.cyclone_watch_alerts'::regclass
           AND tgname = 'account_deletion_write_fence' AND NOT tgisinternal AND tgenabled <> 'D'
    ) THEN
        RAISE EXCEPTION 'cyclone_watch: the account-deletion fence did not install';
    END IF;
END;
$check$;

RESET lock_timeout;
