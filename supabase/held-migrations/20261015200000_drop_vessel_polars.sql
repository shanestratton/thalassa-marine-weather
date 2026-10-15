-- Drop the unused vessel_polars table (2026-10-15, build 132, package
-- 132-B22). Shane, 15 Oct: "drop the unused old vessel_polars table".
--
-- HELD. Written with 132, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and Shane pushes this one himself. Release it
-- by moving it into supabase/migrations under a stamp newer than the newest
-- applied migration and, in the same commit, rewriting
-- tests/DropVesselPolarsMigration.test.ts to read the released file and
-- assert the held copy is gone (the b85cd258d vault-limits release), then
-- push.
--
-- Why it is unused
-- ────────────────
-- A skipper's polar lives in her settings (settings.polarData, synced with
-- the rest of her settings) and in her boat's profile; every router, the
-- Passage HUD and Plan Your Day read it from there (services/routingPolar.ts).
-- vessel_polars was the Polars page's cloud copy in February 2026:
--   * written by nothing since 2026-02-26 (2f723b7c took the Polars page's
--     upsert out);
--   * read by nothing since 2026-10-07 (58031acd took weatherRouter's read
--     out; tests/routingPolar.test.ts and tests/weatherRouter.test.ts pin it);
--   * the fleet backfill (20260727120000_hardened_vessel_fleet.sql) read it
--     once, for each owner's selected boat whose settings held no polar.
-- Searched 2026-10-15, every tracked file: the app (components, services,
-- hooks, utils, stores, context, pages, src), the Pi (bosun-pi, pi-cache),
-- the edge functions (supabase/functions), the workers (cloudflare-worker,
-- workers, api, backend) and the scripts. vessel_polars appears only in
-- migrations, supabase/legacy-sql and tests. tests/DropVesselPolarsMigration
-- .test.ts walks those folders and fails if anything names it again.
--
-- A phone on a build older than 58031acd still asks for its row before a
-- weather route. With the table gone PostgREST answers that with an error,
-- which that build already read as "no polar" (it checked `error` and caught
-- throws), so its route sails the polar it would have sailed anyway.
--
-- What
-- ────
-- * Refuses, and drops nothing, if a row was written after the app stopped
--   writing it: created after 2026-03-01, or updated after 2026-08-14 (the
--   day after 20260813080000 made updated_at advance again). That would mean
--   something this search could not see still writes it.
-- * DROP TABLE public.vessel_polars, without CASCADE: its policies, its
--   triggers (vessel_polars_updated and the account-deletion write fence)
--   and its unique key go with it; a view or key elsewhere that depended on
--   it would fail the push rather than go quietly with it.
-- * DROP FUNCTION public.vessel_polars_set_updated_at(): the trigger function
--   dedicated to it (20260813080000). Without CASCADE as well.
-- Account deletion is unchanged: its write fences are installed per table
-- from the catalogue (20260806120000), and nothing else names this table.
--
-- Undo
-- ────
-- Re-run 20260723095000_vessel_polars.sql, then the function and trigger in
-- 20260813080000_restore_vessel_polars_timestamp.sql. The rows do not come
-- back: before releasing this, keep a copy if Shane wants one
-- (\copy public.vessel_polars to 'vessel_polars.csv' csv header — it holds
-- skippers' polar figures, so it stays off chat and out of the repository).
--
-- Safe to re-run: IF EXISTS on both drops, and the check only runs while the
-- table is there. DROP TABLE takes an ACCESS EXCLUSIVE lock on a table
-- nothing reads; the lock wait is bounded, so a busy table fails the push
-- (retry it) instead of queueing anything behind it. No BEGIN or COMMIT
-- here: the pre-push replay runs this file inside a rolled-back transaction.
--
-- Check it after the push, printing counts only:
--     select to_regclass('public.vessel_polars');                      -> null
--     select count(*) from pg_proc where proname = 'vessel_polars_set_updated_at'; -> 0

SET LOCAL lock_timeout = '5s';

DO $precheck$
DECLARE
    late_rows BIGINT;
BEGIN
    IF to_regclass('public.vessel_polars') IS NULL THEN
        RETURN;
    END IF;
    SELECT count(*)
    INTO late_rows
    FROM public.vessel_polars
    WHERE created_at > TIMESTAMPTZ '2026-03-01 00:00:00+00'
       OR updated_at > TIMESTAMPTZ '2026-08-14 00:00:00+00';
    IF late_rows > 0 THEN
        RAISE EXCEPTION 'drop_vessel_polars: % row(s) written after the app stopped writing vessel_polars; something still writes it, so it is not dropped', late_rows;
    END IF;
END;
$precheck$;

DROP TABLE IF EXISTS public.vessel_polars;

DROP FUNCTION IF EXISTS public.vessel_polars_set_updated_at();
