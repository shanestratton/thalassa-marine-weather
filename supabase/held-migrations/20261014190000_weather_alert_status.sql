-- Forecast alerts that look ahead: the check's status, per run and per
-- account, and the call the app reads (2026-10-14, build 129, package 129-07).
--
-- HELD, and optional: its own yes for Shane. Written with 129, NOT pushed:
-- supabase db push applies every pending file in supabase/migrations, and
-- this one waits until Shane has deployed check-weather-alerts (the
-- look-ahead version). Release it by moving it into supabase/migrations under
-- a stamp newer than the newest applied migration and, in the same commit,
-- rewriting tests/WeatherAlertStatusMigration.test.ts to read the released
-- file and assert the held copy is gone (the b85cd258d release); then push.
-- Until it runs, nothing answers weather_alert_status(), so the app keeps
-- "Look ahead", "Good window opens" and the status hidden, and High seas and
-- Long period keep "Only with app open". The deployed function runs and
-- pushes either way: without these tables it logs one warning a run and
-- writes no status.
--
-- What
-- ────
-- * weather_alert_runs: one row, written at the end of every run: when it
--   ran, the function's version (FORECAST_ALERTS_VERSION, 2 = the look-ahead
--   check), and its counts (accounts, places, requests, weighted calls on
--   the paid Open-Meteo key, pushes, held overnight, covered by an official
--   warning, places over the run's ceiling). Service role only.
-- * weather_alert_status: one row per account the check read: which
--   position it read (basis: 'saved' for the place the weather is set to,
--   'last-known' for the Guardian fix) and its lines, at most 12 strings in
--   4 KB, in the skipper's units ("Wind: models disagree: ECMWF 28 kt,
--   ICON 14 kt, UKMO not shown (your limit 25 kt)."). Never a position and
--   never a UKMO value (CC BY-SA: named and counted, never quoted). Written
--   only when the lines change, and deleted for an account the check no
--   longer reads, so a quiet account costs no write every 30 min. The
--   account-deletion write fence, as every user-keyed table has it, and ON
--   DELETE CASCADE. Service role only.
-- * weather_alert_status(): what the app reads: the last run's version and
--   time, and the caller's own basis and lines, nothing else. Signed-in
--   callers only; SECURITY DEFINER with a pinned search_path.
-- The 'check-weather-alerts' cron job (20261010151900, every 30 min on the
-- vault credential path) is not read or changed here.
--
-- Undo
-- ────
--     DROP FUNCTION IF EXISTS public.weather_alert_status();
--     DROP TABLE IF EXISTS public.weather_alert_status, public.weather_alert_runs;
-- (the app then hides the look-ahead choice again; the function keeps running
-- and pushing, and warns once a run that the status table is not there).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regprocedure('public.block_tombstoned_account_write()') IS NULL THEN
        RAISE EXCEPTION 'weather_alert_status: block_tombstoned_account_write() (the account-deletion fence) is missing';
    END IF;
END;
$precheck$;

CREATE TABLE IF NOT EXISTS public.weather_alert_runs (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    ran_at TIMESTAMPTZ NOT NULL,
    version SMALLINT NOT NULL CHECK (version BETWEEN 1 AND 1000),
    accounts INTEGER,
    places INTEGER,
    requests INTEGER,
    calls NUMERIC,
    pushes INTEGER,
    held INTEGER,
    covered INTEGER,
    skipped INTEGER
);

ALTER TABLE public.weather_alert_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weather_alert_runs FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.weather_alert_status (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    basis TEXT NOT NULL CHECK (basis IN ('saved', 'last-known')),
    lines JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(lines) = 'array'
        AND jsonb_array_length(lines) <= 12
        AND octet_length(lines::text) <= 4096
    ),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_alert_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weather_alert_status FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.weather_alert_status;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.weather_alert_status
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

CREATE OR REPLACE FUNCTION public.weather_alert_status()
RETURNS TABLE (version smallint, ran_at timestamptz, basis text, lines jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT r.version, r.ran_at, s.basis, s.lines
      FROM public.weather_alert_runs AS r
      LEFT JOIN public.weather_alert_status AS s ON s.user_id = auth.uid()
     WHERE r.id = 1;
$$;

REVOKE ALL ON FUNCTION public.weather_alert_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.weather_alert_status() TO authenticated;

RESET lock_timeout;
