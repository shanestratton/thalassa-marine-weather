-- Retire the marketplace schema.
--
-- THIS MIGRATION IS DESTRUCTIVE AND IRREVERSIBLE. Written but NOT applied;
-- run it deliberately, and run the pre-flight counts below first.
--
-- PROVENANCE OF THE "IT IS EMPTY" CLAIM — read this before trusting it.
-- An earlier version of this header asserted exact row counts of 0 for all
-- four tables "verified against production". That claim had no basis: it was
-- never measured. What HAS been measured (2026-08-13, via PostgREST with the
-- anon key) is that marketplace_listings, marketplace_messages and
-- marketplace_escrow all return HTTP 404, where a table that exists but is
-- RLS-protected returns 200 with an empty array and a genuinely absent
-- relation returns 404. That was control-tested against both cases in the
-- same run. So the tables are absent, or at least not exposed to PostgREST —
-- which is evidence, but it is NOT a row count, and it says nothing at all
-- about marketplace_ratings, which has no CREATE TABLE anywhere in this repo.
-- RUN THE PRE-FLIGHT. Do not infer emptiness from this comment.
--
--     SELECT count(*) FROM public.marketplace_listings;
--     SELECT count(*) FROM public.marketplace_escrow;
--     SELECT count(*) FROM public.marketplace_messages;
--     SELECT count(*) FROM public.marketplace_ratings;  -- error = never existed, fine
--     SELECT count(*) FROM storage.objects WHERE bucket_id = 'marketplace-images';
--
-- Any non-zero count: STOP and export before proceeding.
--
-- Order: cron -> re-point the one out-of-feature trigger -> views ->
-- triggers -> functions -> tables. Reversing it leaves a scheduled job
-- invoking a missing function every tick.
--
-- DELIBERATELY NOT DROPPED HERE (each would break a surviving feature):
--   * public.consume_edge_quota() and public.edge_function_rate_limits — the
--     app's only server-side rate-limit primitive, ~20 call sites of which
--     just two were marketplace. Only the 'escrow_pin' counter rows go.
--   * storage bucket 'marketplace-images' and its storage.objects policies —
--     named by account_deletion_storage_inventory() and
--     block_tombstoned_storage_write() in 20260806120000, written AFTER the
--     marketplace was retired. The GDPR/Apple deletion path consumes them.
--     Storage is also not recoverable by database PITR.
--   * chat_profiles.stripe_account_id, and the 'Marketplace'/'Chandlery'
--     chat_channels rows — the latter are what ChannelList's
--     HIDDEN_CHANNEL_NAMES exists to hide, so the hiding code stays too.

-- ── 1. Cron ────────────────────────────────────────────────────────────
-- Unschedule by jobid, matching the working pattern at
-- 20260723090000_security_hardening_core.sql:577. The previous version wrapped
-- these in `EXCEPTION WHEN OTHERS`, which would swallow a real
-- insufficient_privilege or undefined_schema error and then fall through to
-- DROP FUNCTION below — stranding a live schedule pointed at a function that
-- no longer exists, which is precisely the failure this section prevents.
-- A permission failure here MUST abort the transaction.
DO $$
DECLARE existing_job BIGINT;
BEGIN
    SELECT jobid INTO existing_job FROM cron.job
        WHERE jobname = 'sweep-expired-escrows' LIMIT 1;
    IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;

    SELECT jobid INTO existing_job FROM cron.job
        WHERE jobname = 'sweep-expired-marketplace-escrows' LIMIT 1;
    IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;
END;
$$;

-- ── 2. Detach the one surviving consumer FIRST ─────────────────────────
-- public.update_marketplace_timestamp() is a generic `NEW.updated_at = now()`
-- body, and vessel_polars reused it two migrations later
-- (20260723095000_vessel_polars.sql:34-37). The previous version of this file
-- dropped it with CASCADE, which SUCCEEDS SILENTLY and takes
-- vessel_polars_updated with it — after which vessel_polars.updated_at simply
-- stops advancing, with no error, forever. vessel_polars is a surviving
-- feature (services/weatherRouter.ts reads it for routing).
--
-- Re-point it in the same transaction so no UPDATE can land untimestamped.
CREATE OR REPLACE FUNCTION public.vessel_polars_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Guarded on the TABLE existing. `DROP TRIGGER IF EXISTS x ON t` excuses a
-- missing trigger, but not a missing t — and this migration is expected to
-- run against a database where the marketplace tables are already gone
-- (measured 2026-08-13: marketplace_escrow 404s from PostgREST while
-- vessel_polars and edge_function_rate_limits both answer 200). Without
-- these guards the push aborts partway, leaving the cron unscheduled and
-- the schema half-dropped. to_regclass returns NULL instead of raising.
DO $$
BEGIN
    IF to_regclass('public.vessel_polars') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS vessel_polars_updated ON public.vessel_polars;
        CREATE TRIGGER vessel_polars_updated
            BEFORE UPDATE ON public.vessel_polars
            FOR EACH ROW EXECUTE FUNCTION public.vessel_polars_set_updated_at();
    END IF;
END;
$$;

-- ── 3. Views ───────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.marketplace_escrow_seller;
DROP VIEW IF EXISTS public.marketplace_listings_public;

-- ── 4. Triggers ────────────────────────────────────────────────────────
-- Explicit, so the function drops below need no CASCADE. Same table guard.
DO $$
BEGIN
    IF to_regclass('public.marketplace_escrow') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_hash_marketplace_escrow_pin ON public.marketplace_escrow;
        DROP TRIGGER IF EXISTS marketplace_escrow_updated ON public.marketplace_escrow;
    END IF;
    IF to_regclass('public.marketplace_listings') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS marketplace_listings_updated ON public.marketplace_listings;
    END IF;
END;
$$;

-- ── 5. Functions ───────────────────────────────────────────────────────
-- Full signatures, no CASCADE. The previous version used bare names and
-- justified it as drift-tolerance; it is the opposite — bare-name resolution
-- FAILS if a same-named overload ever appears, and every signature here is
-- knowable and stable (each is spelled out in its own REVOKE/GRANT line in
-- the migration that created it). Blanket CASCADE also disarms the alarm:
-- if one of these now errors, something outside the marketplace depends on
-- it and the drop SHOULD stop.
--
-- hash_marketplace_escrow_pin was one of the SECURITY DEFINER functions still
-- carrying an EXECUTE grant to PUBLIC (see 20260728150000, which left it
-- because it is a trigger body). Deleting the feature deletes the exposure.
DROP FUNCTION IF EXISTS public.claim_marketplace_escrow_reconciliation(INTEGER);
DROP FUNCTION IF EXISTS public.complete_marketplace_escrow_cancellation(UUID, TEXT);
DROP FUNCTION IF EXISTS public.finalize_marketplace_escrow_release(UUID, TEXT);
DROP FUNCTION IF EXISTS public.release_marketplace_escrow_capture(UUID, TEXT);
DROP FUNCTION IF EXISTS public.sweep_expired_escrows();
DROP FUNCTION IF EXISTS public.verify_escrow_pin(UUID, TEXT);
DROP FUNCTION IF EXISTS public.hash_marketplace_escrow_pin();
DROP FUNCTION IF EXISTS public.get_listings_within_radius(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, INTEGER);
-- Safe ONLY because section 2 re-pointed vessel_polars_updated above.
DROP FUNCTION IF EXISTS public.update_marketplace_timestamp();

-- ── 6. Tables ──────────────────────────────────────────────────────────
-- Escrow and messages first: both carry foreign keys to listings. By this
-- point every view, function and trigger is already gone, so CASCADE is a
-- no-op — it is retained verbatim on these two because
-- scripts/check-beta-readiness.mjs:3044-3046 asserts these exact strings.
DROP TABLE IF EXISTS public.marketplace_escrow CASCADE;
DROP TABLE IF EXISTS public.marketplace_messages CASCADE;
DROP TABLE IF EXISTS public.marketplace_ratings CASCADE;
DROP TABLE IF EXISTS public.marketplace_listings CASCADE;

-- ── 7. Orphaned rate-limit counters ────────────────────────────────────
-- The table and consume_edge_quota() are SHARED and stay (see the header).
-- Only the marketplace's own bucket rows go: hourly integer counters used by
-- the escrow PIN check, no user content.
DELETE FROM public.edge_function_rate_limits WHERE bucket = 'escrow_pin';
